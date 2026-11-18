Pod::Spec.new do |s|
  s.name           = 'AudioInterruption'
  s.version        = '1.0.0'
  s.summary        = 'Tells the voice conversation when iOS takes the audio away from it, for a call or an alarm.'
  s.description    = 'Tells the voice conversation when iOS takes the audio away from it, for a call or an alarm.'
  s.author         = 'Rerun'
  s.homepage       = 'https://rerun.build'
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
