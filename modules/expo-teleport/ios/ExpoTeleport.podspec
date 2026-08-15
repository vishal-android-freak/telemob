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
    'Frameworks/Teleportmobile.xcframework',
    'Frameworks/ghostty-vt.xcframework'
  ]

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  # The gomobile headers belong exclusively to the vendored XCFramework.
  # Recursively globbing this directory makes CocoaPods add private binding
  # headers such as ref.h to ExpoTeleport's generated umbrella header.
  s.source_files = [
    'ExpoTeleportModule.swift',
    'TeleportTerminalView.swift',
    '../native/telemob_terminal.{h,c}'
  ]
  s.public_header_files = '../native/telemob_terminal.h'
  s.resources = '../native/licenses/GHOSTTY_LICENSE.txt'
end
