const {
  AndroidConfig,
  withAndroidManifest,
  withAndroidStyles,
} = require('@expo/config-plugins');

const DEPRECATED_SYSTEM_BAR_ITEMS = [
  'android:statusBarColor',
  'android:navigationBarColor',
];

function withGooglePlayCompliance(config) {
  config = withAndroidManifest(config, manifestConfig => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(
      manifestConfig.modResults
    );

    // Default orientation is already unrestricted. Omitting the attribute
    // altogether also keeps Play from treating it as a large-screen override.
    delete activity.$['android:screenOrientation'];
    delete activity.$['android:minAspectRatio'];
    delete activity.$['android:maxAspectRatio'];
    activity.$['android:resizeableActivity'] = 'true';

    return manifestConfig;
  });

  return withAndroidStyles(config, stylesConfig => {
    const parent = AndroidConfig.Styles.getAppThemeGroup();

    for (const name of DEPRECATED_SYSTEM_BAR_ITEMS) {
      stylesConfig.modResults = AndroidConfig.Styles.removeStylesItem({
        name,
        parent,
        xml: stylesConfig.modResults,
      });
    }

    return stylesConfig;
  });
}

module.exports = withGooglePlayCompliance;
