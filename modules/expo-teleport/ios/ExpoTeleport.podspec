Pod::Spec.new do |s|
  s.name           = 'ExpoTeleport'
  s.version        = '1.0.0'
  s.summary        = 'Native Teleport transport and browser MFA bridge for Telemob'
  s.description    = 'Links the shared Go Teleport transport into Expo on Apple platforms.'
  s.author         = 'Telemob'
  s.homepage       = 'https://goteleport.com/'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.vendored_frameworks = 'Frameworks/Teleportmobile.xcframework'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
