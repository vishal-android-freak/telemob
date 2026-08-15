export const responsiveLayout = {
  compactWidth: 480,
  splitWidth: 720,
  wideWidth: 840,
  threeColumnWidth: 1120,
  tabletShortEdge: 600,
  contentMaxWidth: 1240,
  loginMaxWidth: 1120,
  nodeGap: 16,
} as const;

export function getResponsiveLayout(width: number, height: number) {
  const landscape = width > height;
  const shortViewport = height < 500;
  const tablet = Math.min(width, height) >= responsiveLayout.tabletShortEdge;
  const compact = width < responsiveLayout.compactWidth;
  const wide = width >= responsiveLayout.wideWidth;
  const split = width >= responsiveLayout.splitWidth && (landscape || tablet);
  const nodeColumns = width >= responsiveLayout.threeColumnWidth
    ? 3
    : width >= responsiveLayout.splitWidth
      ? 2
      : 1;

  return {
    compact,
    landscape,
    nodeColumns,
    shortViewport,
    split,
    tablet,
    wide,
  };
}
