import AVFoundation
import ExpoModulesCore

// While the voice screen is open: says when iOS takes the audio session away, for a phone call, a
// FaceTime call, an alarm or Siri. The conversation ends then rather than coming back on its own.
// It only listens: nothing here changes the audio session.
public class AudioInterruptionModule: Module {
  private var observer: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("AudioInterruption")

    Events("onInterruption")

    // Expo calls these as the first listener is added and the last one removed.
    OnStartObserving {
      self.stopObserving()
      self.observer = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
        self?.sendEvent("onInterruption", ["kind": "audio"])
      }
    }

    OnStopObserving {
      self.stopObserving()
    }

    OnDestroy {
      self.stopObserving()
    }
  }

  private func stopObserving() {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    observer = nil
  }
}
