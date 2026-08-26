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

function resizeBoundsPreservingPosition(current, size, area) {
  const x = Math.min(Math.max(area.x, current.x), area.x + area.width - 1);
  const y = Math.min(Math.max(area.y, current.y), area.y + area.height - 1);
  return {
    x,
    y,
    width: Math.min(size.width, area.x + area.width - x),
    height: Math.min(size.height, area.y + area.height - y),
  };
}

module.exports = { clampBoundsToArea, resizeBoundsFromBottomRight, resizeBoundsPreservingPosition };
