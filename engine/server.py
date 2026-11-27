"""think-aloud's Kokoro voice server: one per Claude Code session, started by the mod once setup.sh has run.

Loads Kokoro-82M once (kokoro-onnx, CPU), then speaks what the mod sends over local HTTP (127.0.0.1, a free port it
prints as "PORT <n>" once the model is loaded):

  POST /speak {"text", "voice", "speed", "epoch", "section"}
        synthesises, waits for the utterance before it to finish, starts playing, and answers {"started": true} as
        it starts, so the mod sends the next one and it is synthesised while this one plays (no gap between
        utterances); {"stopped": true} when a stop (or speech of a newer epoch, or a skip of its section) overtook
        it; 503 when the audio output failed or stalled (the mod then says that line with the Mac voice)
  POST /stop {"epoch"}                    drops what waits and cuts what plays, of every epoch before this one
  POST /skip {"section"}                  "next": cuts what plays of that section and drops what of it waits or
                                          is still being synthesised; the next utterance plays at once
  POST /pause, POST /resume               holds playback where it is (the person is talking) and carries on from
                                          there; what waits keeps waiting, and the stall timer does not run
  GET  /health                            {"ok": true, "voices": [...]}

The epoch is the mod's own count of its hushes: a /stop and the /speak after it can arrive in either order, and the
newer epoch wins either way.

Audio goes out through one output stream, kept open while speech flows (closed after IDLE_CLOSE_S of quiet): a
stream opened per utterance clipped its first syllable while the device woke. If the output fails (headphones
unplugged, another device picked, the Mac asleep) the stream is dropped and the next utterance opens a fresh one.

The server exits when the session that started it is gone (its parent process changes). It writes its pid to
server.<parent pid>.pid in the engine's home, so a reloaded mod in the same session can stop the one before it.
"""

import collections
import json
import os
import queue
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sounddevice as sd
from kokoro_onnx import Kokoro

HOME = os.environ.get("THINK_ALOUD_HOME", os.path.expanduser("~/.claude/think-aloud"))
MODEL = os.path.join(HOME, "models", "kokoro-v1.0.onnx")
VOICES = os.path.join(HOME, "models", "voices-v1.0.bin")
RATE = 24000
LEAD_S = 0.15  # silence written when the stream opens, while the device wakes
GAP_S = 0.12  # between utterances
BLOCK = RATE // 20  # 50 ms: how soon a stop is heard
IDLE_CLOSE_S = 20.0
WAIT_S = 60.0  # how long a /speak waits for its turn to play before it reports a stall
PID_FILE = os.path.join(HOME, f"server.{os.getppid()}.pid")
FOLLOW_EVERY = 20  # blocks (1 s): how often a playing utterance checks whether the Mac's output device changed


def _default_output_reader():
    """The Mac's current default output device (CoreAudio's id), read live: PortAudio only learns the default when it
    starts, so a stream kept open (or reopened) stayed on the earphones after the person picked Speakers (22 Nov 2026)."""
    try:
        import ctypes
        import ctypes.util

        ca = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreAudio"))

        class Address(ctypes.Structure):
            _fields_ = [("selector", ctypes.c_uint32), ("scope", ctypes.c_uint32), ("element", ctypes.c_uint32)]

        four = lambda s: int.from_bytes(s.encode(), "big")  # noqa: E731
        address = Address(four("dOut"), four("glob"), 0)  # default output device, global scope, main element

        def read():
            device, size = ctypes.c_uint32(0), ctypes.c_uint32(4)
            # kAudioObjectSystemObject is 1
            if ca.AudioObjectGetPropertyData(1, ctypes.byref(address), 0, None, ctypes.byref(size), ctypes.byref(device)):
                return None
            return device.value

        return read
    except Exception:
        return lambda: None


default_output = _default_output_reader()


def open_stream():
    """A stream on the Mac's output device as it is now: PortAudio lists the devices again first."""
    try:
        sd._terminate()
        sd._initialize()
    except Exception:
        pass
    stream = sd.OutputStream(samplerate=RATE, channels=1, dtype="float32")
    stream.start()
    stream.write(np.zeros(int(RATE * LEAD_S), dtype=np.float32))
    return stream


def write_pid() -> None:
    try:
        with open(PID_FILE, "w") as f:
            f.write(str(os.getpid()))
    except OSError:
        pass


def leave(*_args) -> None:
    """Exits at once, taking the pid file along if it is still ours."""
    try:
        with open(PID_FILE) as f:
            if f.read().strip() == str(os.getpid()):
                os.remove(PID_FILE)
    except OSError:
        pass
    os._exit(0)


# Before the model loads (seconds): a reloaded mod can stop this one even while it is still loading.
write_pid()
signal.signal(signal.SIGTERM, leave)

kokoro = Kokoro(MODEL, VOICES)
voices = sorted(kokoro.get_voices())
synth_lock = threading.Lock()


class Item:
    """One utterance: its audio, its epoch, and whether it began playing (`started` is set either way)."""

    def __init__(self, epoch: int, audio: np.ndarray, section: str = "") -> None:
        self.epoch = epoch
        self.audio = audio
        self.section = section
        self.skipped = False
        self.started = threading.Event()
        self.played = False


def close(stream, abort: bool = False) -> None:
    """Closes an output stream, whatever state the device left it in; always None (no stream)."""
    if stream is not None:
        try:
            if abort:
                stream.abort()
            stream.close()
        except Exception:
            pass
    return None


class Player:
    def __init__(self) -> None:
        self.epoch = 0
        # The epoch, the queue and its draining move together: a /stop between a check and a put lost nothing.
        self.lock = threading.Lock()
        self.items: "queue.Queue[Item]" = queue.Queue()
        self.current: "Item | None" = None
        # Sections skipped lately: an utterance of one still being synthesised is dropped when it is put.
        self.skipped: "collections.deque[str]" = collections.deque(maxlen=64)
        # Set while playing may go on; cleared by /pause.
        self.resumed = threading.Event()
        self.resumed.set()
        threading.Thread(target=self._run, daemon=True).start()

    def skip(self, section: str) -> None:
        """The section goes: what of it plays is cut at its next block, what of it waits is dropped."""
        with self.lock:
            self.skipped.append(section)
            if self.current is not None and self.current.section == section:
                self.current.skipped = True
            kept = []
            while True:
                try:
                    item = self.items.get_nowait()
                except queue.Empty:
                    break
                if item.section == section:
                    item.skipped = True
                    item.started.set()
                else:
                    kept.append(item)
            for item in kept:
                self.items.put(item)

    def advance(self, epoch: int) -> None:
        """Everything of an epoch before `epoch` goes: what waits now, what plays at its next block."""
        with self.lock:
            if epoch <= self.epoch:
                return
            self.epoch = epoch
            while True:
                try:
                    self.items.get_nowait().started.set()
                except queue.Empty:
                    return

    def put(self, item: Item) -> bool:
        with self.lock:
            if item.epoch != self.epoch or (item.section and item.section in self.skipped):
                return False
            self.items.put(item)
            return True

    def hold(self, item: Item) -> bool:
        """Waits while paused; whether the item is still wanted after (a stop or a skip may come meanwhile)."""
        while not self.resumed.wait(0.5):
            if item.epoch != self.epoch or item.skipped:
                return False
        return item.epoch == self.epoch and not item.skipped

    def _run(self) -> None:
        stream = None
        device = None  # the Mac's output device the stream was opened on
        last = 0.0
        while True:
            try:
                item = self.items.get(timeout=1.0)
            except queue.Empty:
                if stream is not None and time.monotonic() - last > IDLE_CLOSE_S:
                    stream = close(stream)
                continue
            try:
                if item.epoch != self.epoch or item.skipped:
                    continue
                # The person picked another output (Speakers, earphones) since the stream opened: follow it.
                if stream is not None and default_output() != device:
                    stream = close(stream)
                if stream is None:
                    device = default_output()
                    stream = open_stream()
                if not self.hold(item):
                    continue
                with self.lock:
                    self.current = item
                item.played = True
                item.started.set()
                cut = False
                for n, i in enumerate(range(0, len(item.audio), BLOCK)):
                    if not self.resumed.is_set():
                        # Paused: what the device holds stops at once, and the rest plays from here on resume.
                        stream = close(stream, abort=True)
                        if self.hold(item):
                            device = default_output()
                            stream = open_stream()
                    if item.epoch != self.epoch or item.skipped:
                        cut = True
                        break
                    if n and n % FOLLOW_EVERY == 0 and default_output() != device:
                        # Switched mid-utterance: the rest of it plays on the new output.
                        stream = close(stream, abort=True)
                        device = default_output()
                        stream = open_stream()
                    stream.write(item.audio[i : i + BLOCK])
                if cut:
                    # What the device still holds goes too: a stop is heard at once.
                    stream = close(stream, abort=True)
                else:
                    stream.write(np.zeros(int(RATE * GAP_S), dtype=np.float32))
            except Exception:
                # The output went away (headphones off, another device picked, the Mac asleep): this thread was the
                # only player, and it died here, so every /speak after waited forever (Neon review #1). The stream
                # goes, PortAudio lists the devices again, and the next utterance opens a fresh one.
                stream = close(stream, abort=True)
                try:
                    sd._terminate()
                    sd._initialize()
                except Exception:
                    pass
            finally:
                with self.lock:
                    if self.current is item:
                        self.current = None
                item.started.set()
                last = time.monotonic()


player = Player()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args) -> None:  # quiet: stdout is the mod's
        pass

    def _send(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send(200, {"ok": True, "voices": voices})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            body = {}
        if not isinstance(body, dict):
            body = {}
        epoch = body.get("epoch")
        if self.path == "/stop":
            player.advance(epoch if isinstance(epoch, int) else player.epoch + 1)
            self._send(200, {"ok": True})
            return
        if self.path == "/skip":
            section = body.get("section")
            if isinstance(section, str) and section:
                player.skip(section)
            self._send(200, {"ok": True})
            return
        if self.path in ("/pause", "/resume"):
            (player.resumed.clear if self.path == "/pause" else player.resumed.set)()
            self._send(200, {"ok": True})
            return
        if self.path != "/speak":
            self._send(404, {"error": "not found"})
            return
        # A /speak of a newer epoch than the last /stop: the stop is on its way, and this is what comes after it.
        if isinstance(epoch, int):
            player.advance(epoch)
        else:
            epoch = player.epoch
        if epoch < player.epoch:
            self._send(200, {"stopped": True})
            return
        text = str(body.get("text") or "").strip()
        voice = str(body.get("voice") or "af_heart")
        if voice not in voices:
            voice = "af_heart"
        try:
            speed = min(2.0, max(0.5, float(body.get("speed") or 1.0)))
        except (TypeError, ValueError):
            speed = 1.0
        if not text:
            self._send(200, {"started": False})
            return
        try:
            with synth_lock:
                # British voices (bf_/bm_) speak British English; the rest American.
                audio, _ = kokoro.create(text, voice=voice, speed=speed, lang="en-gb" if voice.startswith("b") else "en-us")
        except Exception as e:  # a text the phonemiser cannot take: skip it
            self._send(200, {"error": str(e)[:200]})
            return
        section = body.get("section")
        item = Item(epoch, np.asarray(audio, dtype=np.float32), section if isinstance(section, str) else "")
        if not player.put(item):
            self._send(200, {"stopped": True})
            return
        # A stall is WAIT_S of waiting while not paused: a pause may last as long as the person talks.
        waited = 0.0
        while not item.started.wait(timeout=0.5):
            if player.resumed.is_set():
                waited += 0.5
            if waited >= WAIT_S:
                break
        if not item.started.is_set():
            self._send(503, {"error": "playback stalled"})
        elif item.played:
            self._send(200, {"started": True})
        elif item.epoch != player.epoch or item.skipped:
            self._send(200, {"stopped": True})
        else:
            self._send(503, {"error": "playback failed"})


def watch_parent(parent: int) -> None:
    while True:
        time.sleep(2)
        if os.getppid() != parent:
            leave()


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True  # a /speak still waiting never holds the exit up
    threading.Thread(target=watch_parent, args=(os.getppid(),), daemon=True).start()
    print(f"PORT {server.server_address[1]}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        leave()
