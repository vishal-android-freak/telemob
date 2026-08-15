Pod::Spec.new do |s|
  s.name           = 'ExpoTeleport'
  s.version        = '1.0.0'
  s.summary        = 'Native Teleport transport and browser MFA bridge for Telemob'
  s.description    = 'Links the shared Go Teleport transport into Expo on Apple platforms.'
  s.author         = 'Telemob'
  s.homepage       = 'https://goteleport.com/'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.vendored_frameworks = [
    'ios/Frameworks/Teleportmobile.xcframework',
    'ios/Frameworks/ghostty-vt.xcframework'
  ]

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  # Keep the podspec at the module root so CocoaPods can package the shared C
  # terminal core directly. Android compiles these same files with CMake.
  s.source_files = [
    'ios/ExpoTeleportModule.swift',
    'ios/TeleportTerminalView.swift',
    'native/telemob_terminal.{h,c}'
  ]
  s.public_header_files = 'native/telemob_terminal.h'
  s.resources = 'native/licenses/GHOSTTY_LICENSE.txt'
end
