// Emits an event when macOS reports a usable network path or changes that path.
import Foundation
import Network
import Darwin

@main
struct PenkraNetworkPathMonitor {
  static func processArguments(_ pid: Int32) -> [String]? {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = 0
    guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size, size < 4_194_304 else { return nil }
    var bytes = [UInt8](repeating: 0, count: size)
    guard sysctl(&mib, 3, &bytes, &size, nil, 0) == 0 else { return nil }
    let count = bytes.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
    guard count > 0 && count < 1024 else { return nil }
    var offset = MemoryLayout<Int32>.size
    while offset < size && bytes[offset] != 0 { offset += 1 }
    while offset < size && bytes[offset] == 0 { offset += 1 }
    var arguments: [String] = []
    for _ in 0..<count {
      let start = offset
      while offset < size && bytes[offset] != 0 { offset += 1 }
      guard offset < size, let arg = String(bytes: bytes[start..<offset], encoding: .utf8) else { return nil }
      arguments.append(arg)
      offset += 1
    }
    return arguments
  }

  static func main() {
    if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--process-identity" {
      guard let pid = Int32(CommandLine.arguments[2]), pid > 0 else { exit(2) }
      var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
      var info = proc_bsdinfo()
      guard proc_pidpath(pid, &path, UInt32(path.count)) > 0,
            proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) > 0 else { exit(1) }
      guard let arguments = processArguments(pid) else { exit(1) }
      let identity: [String: Any] = ["path": String(cString: path), "startedAt": info.pbi_start_tvsec, "arguments": arguments]
      guard let data = try? JSONSerialization.data(withJSONObject: identity) else { exit(1) }
      FileHandle.standardOutput.write(data)
      return
    }
    let monitor = NWPathMonitor()
    var previousPath: NWPath?
    monitor.pathUpdateHandler = { path in
      let changed = previousPath.map { $0 != path } ?? false
      previousPath = path
      if changed && path.status == .satisfied {
        FileHandle.standardOutput.write(Data("path-satisfied\n".utf8))
      }
    }
    monitor.start(queue: DispatchQueue(label: "com.penkra.network-path"))
    dispatchMain()
  }
}
