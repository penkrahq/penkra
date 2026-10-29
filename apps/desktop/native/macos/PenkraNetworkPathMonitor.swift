// Emits an event when macOS reports a usable network path or changes that path.
import Foundation
import Network

@main
struct PenkraNetworkPathMonitor {
  static func main() {
    let monitor = NWPathMonitor()
    monitor.pathUpdateHandler = { path in
      if path.status == .satisfied {
        FileHandle.standardOutput.write(Data("path-satisfied\n".utf8))
      }
    }
    monitor.start(queue: DispatchQueue(label: "com.penkra.network-path"))
    dispatchMain()
  }
}
