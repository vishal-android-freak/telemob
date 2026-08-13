module.exports = ({ config }) => {
  const passkeyDomains = (process.env.EXPO_TELEPORT_PASSKEY_DOMAINS || '')
    .split(',')
    .map(domain => domain.trim())
    .filter(Boolean);

  return {
    ...config,
    ios: {
      ...config.ios,
      ...(passkeyDomains.length > 0
        ? {
            associatedDomains: passkeyDomains.map(
              domain => `webcredentials:${domain}`
            ),
          }
        : {}),
    },
  };
};
