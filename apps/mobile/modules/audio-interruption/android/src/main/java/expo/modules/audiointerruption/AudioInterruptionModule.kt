package expo.modules.audiointerruption

import android.content.Context
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// While the voice screen is open: says when a phone call rings or starts. Android tells an app about
// calls only with the phone permission, which Rerun does not ask for, so the audio mode is read
// instead: the system puts it in RINGTONE or IN_CALL for a call, while the conversation's own audio
// stays IN_COMMUNICATION. It only reads: nothing here changes the audio.
class AudioInterruptionModule : Module() {
  private val handler = Handler(Looper.getMainLooper())
  private var watching = false

  private val check = object : Runnable {
    override fun run() {
      if (!watching) return
      val audio = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
      val mode = audio?.mode
      if (mode == AudioManager.MODE_RINGTONE || mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_CALL_SCREENING) {
        sendEvent("onInterruption", mapOf("kind" to "call"))
      }
      handler.postDelayed(this, POLL_MS)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("AudioInterruption")

    Events("onInterruption")

    // Expo calls these as the first listener is added and the last one removed.
    OnStartObserving {
      handler.removeCallbacks(check)
      watching = true
      handler.post(check)
    }

    OnStopObserving { stop() }

    OnDestroy { stop() }
  }

  private fun stop() {
    watching = false
    handler.removeCallbacks(check)
  }

  companion object {
    const val POLL_MS = 500L
  }
}
