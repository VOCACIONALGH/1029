// export.js
// Mantido mínimo — a funcionalidade de download da nuvem foi implementada em main.js.
// Deixei um utilitário para formatar a nuvem caso queira reutilizar externamente.

window.formatPointCloudPayload = function(triangulatedMap) {
    const triangulatedPoints = [];
    for (const [key, p] of triangulatedMap.entries()) {
        const [px, py] = key.split(',').map(Number);
        triangulatedPoints.push({ pixelX: px, pixelY: py, x_mm: p.x, y_mm: p.y, z_mm: p.z });
    }
    return {
        createdAt: new Date().toISOString(),
        units: "mm",
        pointCount: triangulatedPoints.length,
        points: triangulatedPoints
    };
};
