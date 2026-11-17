Pod::Spec.new do |s|
  s.name           = 'MacPairingTransport'
  s.version        = '1.0.0'
  s.summary        = 'Talks to a paired Mac over HTTPS, trusting only the certificate the Mac showed when pairing.'
  s.description    = 'Talks to a paired Mac over HTTPS, trusting only the certificate the Mac showed when pairing.'
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
