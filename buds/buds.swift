// think-aloud-buds: earbud taps for think-aloud (OPPO / OnePlus / realme buds; tested on OnePlus Nord Buds 3).
//
// The buds report each gesture on their control service (protocol: github.com/junedkhatri31/buds-control, MIT,
// docs/PROTOCOL.md): event 0x0204 with id 0xF1, then side (1 left, 2 right), button, action (2 double tap, 3 triple
// tap). They report only gestures set to a media function (next / previous); the map is set by `setup`. Read over BLE
// (GATT), which leaves the classic channel to any other app.
//
//   listen         prints "tap L 2" / "tap R 3", "buds <name>", "nobuds". The buds send the Mac's player a plain "play"
//                  with every gesture too: after a double or triple tap this pauses the player again (a video never
//                  starts by itself, and talking to Claude pauses it). Left single tap stays play/pause for videos.
//   type <hex>     types bytes into this process's terminal (TIOCSTI on its controlling tty): "20" Space, "0d" Enter
//   hold           types a Space every 30 ms until killed (a held Space bar, for Claude Code's hold-to-talk)
//   mics           the inputs, one a line: "<id>\t<default 0|1>\t<kind>\t<name>" (kind: usb, bluetooth, builtin (lid
//                  closed: builtin-off, it hears nothing), continuity, virtual, other)
//   mic <id>       makes it the default input
//   setup          sets double tap = next, triple tap = previous on both buds (the gestures that report), left single
//                  tap = play/pause, right single tap = none; reads the map back
import AppKit
import CoreAudio
import CoreBluetooth
import Foundation
import IOKit

func out(_ s: String) { print(s); fflush(stdout) }

let service = CBUUID(string: "0000079A-D102-11E1-9B23-00025B00A5A5")
let notifyChar = CBUUID(string: "0200079A-D102-11E1-9B23-00025B00A5A5")
let writeChar = CBUUID(string: "0100079A-D102-11E1-9B23-00025B00A5A5")

/// One frame: AA | varint(len) | flags | 00 | [fsn] | cmd u16le | seq | len u16le | payload.
func frame(cmd: UInt16, seq: UInt8, payload: [UInt8]) -> Data {
  var inner: [UInt8] = [UInt8(cmd & 0xFF), UInt8(cmd >> 8), seq, UInt8(payload.count & 0xFF), UInt8(payload.count >> 8)]
  inner += payload
  var len = inner.count + 2
  var varint: [UInt8] = []
  repeat {
    var b = UInt8(len & 0x7F)
    len >>= 7
    if len != 0 { b |= 0x80 }
    varint.append(b)
  } while len != 0
  return Data([0xAA] + varint + [0x00, 0x00] + inner)
}

/// (cmd, payload) of an unfragmented frame.
func parse(_ d: [UInt8]) -> (UInt16, [UInt8])? {
  guard d.first == 0xAA else { return nil }
  var i = 1
  while i < d.count, d[i] & 0x80 != 0 { i += 1 }
  i += 1
  guard i + 1 < d.count, d[i] & 3 == 0 else { return nil }
  i += 2
  guard i + 5 <= d.count else { return nil }
  let cmd = UInt16(d[i]) | UInt16(d[i + 1]) << 8
  let n = Int(d[i + 3]) | Int(d[i + 4]) << 8
  let start = i + 5
  return (cmd, Array(d[start..<min(d.count, start + n)]))
}

final class Buds: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  let mode: String
  var cm: CBCentralManager!
  var peripheral: CBPeripheral?
  var writer: CBCharacteristic?
  var seq: UInt8 = 0
  init(mode: String) {
    self.mode = mode
    super.init()
    cm = CBCentralManager(delegate: self, queue: nil)
  }
  func centralManagerDidUpdateState(_ c: CBCentralManager) {
    if c.state == .poweredOn { find() } else if mode == "setup" { out("bluetooth off"); exit(2) }
  }
  /// The buds already connected to this Mac (the system holds the link): nothing to pair or scan for.
  func find() {
    guard peripheral == nil else { return }
    if let p = cm.retrieveConnectedPeripherals(withServices: [service]).first {
      peripheral = p
      p.delegate = self
      cm.connect(p)
    } else {
      if mode == "setup" { out("nobuds"); exit(3) }
      out("nobuds")
      DispatchQueue.main.asyncAfter(deadline: .now() + 10) { self.find() }
    }
  }
  func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) { p.discoverServices([service]) }
  func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) { lost() }
  func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) { lost() }
  func lost() {
    peripheral = nil
    writer = nil
    out("nobuds")
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { self.find() }
  }
  func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
    for s in p.services ?? [] where s.uuid == service { p.discoverCharacteristics([notifyChar, writeChar], for: s) }
  }
  func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
    for ch in s.characteristics ?? [] {
      if ch.uuid == notifyChar { p.setNotifyValue(true, for: ch) }
      if ch.uuid == writeChar { writer = ch }
    }
  }
  func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor ch: CBCharacteristic, error: Error?) {
    guard ch.uuid == notifyChar, ch.isNotifying else { return }
    out("buds \(p.name ?? "earbuds")")
    if mode == "setup" { setup() }
  }
  func send(_ cmd: UInt16, _ payload: [UInt8]) {
    guard let p = peripheral, let w = writer else { return }
    p.writeValue(frame(cmd: cmd, seq: seq, payload: payload), for: w, type: .withResponse)
    seq &+= 1
  }
  /// Double tap = next (6), triple tap = previous (5), left (1) and right (2), button 1: the gestures that report.
  /// Left single tap = play/pause (1) for videos and music; right single tap = none (0).
  func setup() {
    send(0x0401, [6, 1, 1, 2, 6, 1, 1, 3, 5, 2, 1, 2, 6, 2, 1, 3, 5, 1, 1, 1, 1, 2, 1, 1, 0])
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.send(0x0108, []) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 4) { out("timeout"); exit(4) }
  }
  func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
    guard let (cmd, payload) = parse([UInt8](ch.value ?? Data())) else { return }
    if cmd == 0x0204, payload.count >= 4, payload[0] == 0xF1 {
      out("tap \(payload[1] == 1 ? "L" : "R") \(payload[3])")
      // The "play" the buds sent with it reached the Mac's player a moment ago: undo it.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { pausePlayer() }
    } else if mode == "setup", cmd == 0x8401 {
      out(payload.first == 0 ? "set" : "refused \(payload.first ?? 0)")
    } else if mode == "setup", cmd == 0x8108, payload.count >= 2 {
      var map: [String] = []
      var i = 2
      while i + 3 < payload.count {
        map.append("\(payload[i] == 1 ? "L" : "R") action \(payload[i + 2]) = function \(payload[i + 3])")
        i += 4
      }
      out("map: " + map.joined(separator: ", "))
      exit(0)
    }
  }
}

/// Pause to whatever the Mac's media keys reach now (MediaRemote's own command, as the keyboard's would be).
func pausePlayer() {
  typealias Send = @convention(c) (UInt32, CFDictionary?) -> Bool
  guard let h = dlopen("/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote", RTLD_NOW),
        let f = dlsym(h, "MRMediaRemoteSendCommand") else { return }
  _ = unsafeBitCast(f, to: Send.self)(1, nil)  // kMRPause
}

func typeIn(_ bytes: [UInt8]) -> Bool {
  let fd = open("/dev/tty", O_RDWR)
  guard fd >= 0 else { return false }
  defer { close(fd) }
  let TIOCSTI: UInt = 0x8001_7472  // _IOW('t', 114, char)
  for var b in bytes where ioctl(fd, TIOCSTI, &b) != 0 { return false }
  return true
}

func audioProp<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope, _ def: T) -> T {
  var a = AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
  var v = def
  var size = UInt32(MemoryLayout<T>.size)
  AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &v)
  return v
}

func deviceName(_ id: AudioObjectID) -> String {
  var a = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var name: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  AudioObjectGetPropertyData(id, &a, 0, nil, &size, &name)
  return (name?.takeRetainedValue() as String?) ?? "?"
}

func defaultInput() -> AudioObjectID {
  audioProp(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal, AudioObjectID(0))
}

func transport(_ id: AudioObjectID) -> UInt32 {
  audioProp(id, kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal, UInt32(0))
}

func hasInput(_ id: AudioObjectID) -> Bool {
  var s = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
  var n: UInt32 = 0
  AudioObjectGetPropertyDataSize(id, &s, 0, nil, &n)
  return n > 0
}

func lidClosed() -> Bool {
  let root = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
  defer { IOObjectRelease(root) }
  let v = IORegistryEntryCreateCFProperty(root, "AppleClamshellState" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
  return (v as? Bool) ?? false
}

func kind(_ id: AudioObjectID) -> String {
  switch transport(id) {
  case kAudioDeviceTransportTypeUSB: return "usb"
  case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "bluetooth"
  case kAudioDeviceTransportTypeBuiltIn: return lidClosed() ? "builtin-off" : "builtin"
  case kAudioDeviceTransportTypeContinuityCaptureWired, kAudioDeviceTransportTypeContinuityCaptureWireless: return "continuity"
  case kAudioDeviceTransportTypeVirtual, kAudioDeviceTransportTypeAggregate: return "virtual"
  default: return "other"
  }
}

func inputs() -> [AudioObjectID] {
  var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size)
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &ids)
  return ids.filter(hasInput)
}

func setDefaultInput(_ id: AudioObjectID) -> Bool {
  var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var v = id
  return AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, UInt32(MemoryLayout<AudioObjectID>.size), &v) == noErr
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "listen":
  NSApplication.shared.setActivationPolicy(.prohibited)
  let buds = Buds(mode: "listen")
  // Ends with the session: the parent gone, this is reparented to launchd.
  let parent = getppid()
  Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in if getppid() != parent { exit(0) } }
  out("ready \(getpid())")
  _ = buds
  NSApplication.shared.run()
case "setup":
  let buds = Buds(mode: "setup")
  _ = buds
  DispatchQueue.main.asyncAfter(deadline: .now() + 15) { out("timeout"); exit(4) }
  RunLoop.main.run()
case "type":
  let hex = args.count > 2 ? args[2] : ""
  let bytes = stride(from: 0, to: hex.count - 1, by: 2).compactMap { i -> UInt8? in
    let s = hex.index(hex.startIndex, offsetBy: i)
    return UInt8(hex[s...hex.index(after: s)], radix: 16)
  }
  exit(typeIn(bytes) ? 0 : 1)
case "hold":
  let parent = getppid()
  let end = Date().addingTimeInterval(600)
  while Date() < end, getppid() == parent {
    if !typeIn([0x20]) { exit(1) }
    usleep(30_000)
  }
case "mics":
  let current = defaultInput()
  for id in inputs() { out("\(id)\t\(id == current ? 1 : 0)\t\(kind(id))\t\(deviceName(id))") }
case "mic":
  guard args.count > 2, let id = AudioObjectID(args[2]) else { exit(64) }
  exit(setDefaultInput(id) ? 0 : 1)
default:
  out("usage: think-aloud-buds listen | setup | type <hex> | hold | mics | mic <id>")
  exit(64)
}
