import ExpoModulesCore
import ObjectiveC
import UIKit

// React Native's text view only pastes text: an image on the pasteboard leaves Paste out of its menu
// and does nothing when the keyboard's own Paste is tapped. In the composer, and only there, Paste
// hands the images to JS as JPEG files, to become attachments; the text next to them, if any, is
// pasted as usual.
public class ComposerPasteModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ComposerPaste")

    Events("onPasteImages")

    OnCreate {
      DispatchQueue.main.async { ComposerPaste.install() }
    }

    OnStartObserving {
      ComposerPaste.onImages = { [weak self] uris in
        self?.sendEvent("onPasteImages", ["uris": uris])
      }
    }

    OnStopObserving {
      ComposerPaste.onImages = nil
    }
  }
}

enum ComposerPaste {
  // The composer's `testID`, which React Native sets on the view wrapping its text view.
  static let composerIdentifier = "composer-input"
  static var onImages: (([String]) -> Void)?
  private static var installed = false

  static func install() {
    guard !installed, let textView = NSClassFromString("RCTUITextView") else { return }
    installed = true
    replaceCanPerformAction(of: textView)
    replacePaste(of: textView)
  }

  // Only the class's own method is replaced, never the one UITextView hands down to every text view.
  private static func ownMethod(_ selector: Selector, of cls: AnyClass) -> Method? {
    guard let inherited = class_getInstanceMethod(cls, selector) else { return nil }
    _ = class_addMethod(cls, selector, method_getImplementation(inherited), method_getTypeEncoding(inherited))
    return class_getInstanceMethod(cls, selector)
  }

  private static func replaceCanPerformAction(of cls: AnyClass) {
    let selector = #selector(UIResponder.canPerformAction(_:withSender:))
    guard let method = ownMethod(selector, of: cls) else { return }
    typealias Original = @convention(c) (AnyObject, Selector, Selector, AnyObject?) -> Bool
    let original = unsafeBitCast(method_getImplementation(method), to: Original.self)
    let replacement: @convention(block) (UIView, Selector, AnyObject?) -> Bool = { view, action, sender in
      if original(view, selector, action, sender) { return true }
      return action == #selector(UIResponderStandardEditActions.paste(_:)) && takesImages(view) && UIPasteboard.general.hasImages
    }
    method_setImplementation(method, imp_implementationWithBlock(replacement))
  }

  private static func replacePaste(of cls: AnyClass) {
    let selector = #selector(UIResponderStandardEditActions.paste(_:))
    guard let method = ownMethod(selector, of: cls) else { return }
    typealias Original = @convention(c) (AnyObject, Selector, AnyObject?) -> Void
    let original = unsafeBitCast(method_getImplementation(method), to: Original.self)
    let replacement: @convention(block) (UIView, AnyObject?) -> Void = { view, sender in
      if takesImages(view), UIPasteboard.general.hasImages, let handler = onImages {
        let uris = write(UIPasteboard.general.images ?? [])
        if !uris.isEmpty {
          handler(uris)
          if !UIPasteboard.general.hasStrings { return }
        }
      }
      original(view, selector, sender)
    }
    method_setImplementation(method, imp_implementationWithBlock(replacement))
  }

  private static func takesImages(_ view: UIView) -> Bool {
    guard onImages != nil else { return false }
    var current: UIView? = view
    while let candidate = current {
      if candidate.accessibilityIdentifier == composerIdentifier { return true }
      current = candidate.superview
    }
    return false
  }

  // JPEG at the quality the photo picker uses, in the caches iOS may empty: the upload reads it once.
  private static func write(_ images: [UIImage]) -> [String] {
    let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("composer-paste", isDirectory: true)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    return images.compactMap { image in
      guard let data = image.jpegData(compressionQuality: 0.8) else { return nil }
      let file = folder.appendingPathComponent("pasted-\(UUID().uuidString.prefix(8).lowercased()).jpg")
      guard (try? data.write(to: file)) != nil else { return nil }
      return file.absoluteString
    }
  }
}
