Pod::Spec.new do |s|
  s.name           = 'NoxCrypto'
  s.version        = '1.0.0'
  s.summary        = 'Event ids hashed natively for nox'
  s.license        = 'MIT'
  s.author         = 'nox'
  s.homepage       = 'https://nox.garden'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
