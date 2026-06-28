function createInvertedMask(features, map) {
  // Create a giant polygon for the whole world
  const world = [
    [90, -180],
    [90, 180],
    [-90, 180],
    [-90, -180]
  ];

  // Extract all coordinates from the features as holes
  const holes = [];
  features.forEach(f => {
    if (f.geometry.type === 'Polygon') {
      holes.push(f.geometry.coordinates[0].map(c => [c[1], c[0]]));
    } else if (f.geometry.type === 'MultiPolygon') {
      f.geometry.coordinates.forEach(poly => {
        holes.push(poly[0].map(c => [c[1], c[0]]));
      });
    }
  });

  return L.polygon([world, ...holes], {
    color: 'transparent',
    fillColor: '#000000',
    fillOpacity: 0.8,
    interactive: false,
    zIndex: 90 // Just below the state highlight, but above HCHO
  });
}
