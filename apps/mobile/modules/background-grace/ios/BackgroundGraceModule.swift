import ExpoModulesCore
import UIKit

// One grace at a time: iOS hands out about thirty seconds once the app leaves the screen, and ends
// them through the expiration handler if the app has not given them back by then.
public class BackgroundGraceModule: Module {
  private var task: UIBackgroundTaskIdentifier = .invalid
  private var expired = false

  public func definition() -> ModuleDefinition {
    Name("BackgroundGrace")

    AsyncFunction("begin") { () -> Double in
      self.finish()
      self.expired = false
      self.task = UIApplication.shared.beginBackgroundTask(withName: "chat-stream") {
        self.expired = true
        self.finish()
      }
      if self.task == .invalid { return 0 }
      return min(UIApplication.shared.backgroundTimeRemaining, 30)
    }
    .runOnQueue(.main)

    // False when iOS took the time back first: the app was suspended, so whatever it held open is gone.
    AsyncFunction("end") { () -> Bool in
      let kept = !self.expired
      self.finish()
      return kept
    }
    .runOnQueue(.main)

    OnDestroy {
      DispatchQueue.main.async { self.finish() }
    }
  }

  private func finish() {
    guard task != .invalid else { return }
    UIApplication.shared.endBackgroundTask(task)
    task = .invalid
  }
}
