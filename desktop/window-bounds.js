'use strict';

function clampBoundsToArea(bounds, area) {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  const maxX = area.x + area.width - width;
  const maxY = area.y + area.height - height;
  return {
    x: Math.min(Math.max(area.x, bounds.x), maxX),
    y: Math.min(Math.max(area.y, bounds.y), maxY),
    width,
    height,
  };
}

function resizeBoundsFromBottomRight(current, size, area) {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  return clampBoundsToArea({
    x: current.x + current.width - width,
    y: current.y + current.height - height,
    width,
    height,
  }, area);
}

module.exports = { clampBoundsToArea, resizeBoundsFromBottomRight };
