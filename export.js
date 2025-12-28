// export.js
// Converte uma nuvem de pontos [{x,y,z}, ...] em malha triangular (.ply ASCII)
// Implementação simples: projeto em XY + Delaunay (Bowyer–Watson) para gerar triângulos.
// Expõe: window.convertPointCloudToMeshAndDownload(points)

(function () {
  // helper: area of triangle (2D)
  function triArea2(a, b, c) {
    return 0.5 * ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  }

  // circumcircle test: returns true if p is inside circumcircle of triangle (a,b,c)
  function pointInCircumcircle(a, b, c, p) {
    // using robust formula (translate so p is origin)
    const ax = a.x - p.x, ay = a.y - p.y;
    const bx = b.x - p.x, by = b.y - p.y;
    const cx = c.x - p.x, cy = c.y - p.y;
    const det = (ax * ax + ay * ay) * (bx * cy - cx * by)
              - (bx * bx + by * by) * (ax * cy - cx * ay)
              + (cx * cx + cy * cy) * (ax * by - bx * ay);
    return det > 0;
  }

  // Bowyer-Watson Delaunay triangulation in 2D (XY)
  function delaunayTriangles(points) {
    // points: array of {x,y}
    const n = points.length;
    if (n < 3) return [];

    // bounding super-triangle (large)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const dx = maxX - minX, dy = maxY - minY;
    const deltaMax = Math.max(dx, dy);
    const midx = (minX + maxX) / 2;
    const midy = (minY + maxY) / 2;

    // create super triangle vertices
    const superA = { x: midx - 20 * deltaMax, y: midy - deltaMax };
    const superB = { x: midx, y: midy + 20 * deltaMax };
    const superC = { x: midx + 20 * deltaMax, y: midy - deltaMax };

    // vertices array = original points followed by super vertices
    const V = points.slice();
    const ia = V.length; V.push(superA);
    const ib = V.length; V.push(superB);
    const ic = V.length; V.push(superC);

    // triangles list: each tri is {a,b,c} indices into V
    let triangles = [{ a: ia, b: ib, c: ic }];

    // add points one by one
    for (let i = 0; i < n; i++) {
      const p = V[i];
      const badTriangles = [];
      for (const tri of triangles) {
        const A = V[tri.a], B = V[tri.b], C = V[tri.c];
        if (pointInCircumcircle(A, B, C, p)) {
          badTriangles.push(tri);
        }
      }

      // find polygon boundary (edges) of hole
      const edges = [];
      function edgeKey(u, v) {
        return u < v ? u + "_" + v : v + "_" + u;
      }
      const edgeCount = Object.create(null);
      for (const tri of badTriangles) {
        const e = [[tri.a, tri.b], [tri.b, tri.c], [tri.c, tri.a]];
        for (const [u, v] of e) {
          const k = edgeKey(u, v);
          edgeCount[k] = (edgeCount[k] || 0) + 1;
        }
      }
      for (const k in edgeCount) {
        if (edgeCount[k] === 1) {
          // boundary edge
          const parts = k.split("_").map(s => parseInt(s, 10));
          edges.push({ u: parts[0], v: parts[1] });
        }
      }

      // remove bad triangles
      triangles = triangles.filter(t => badTriangles.indexOf(t) === -1);

      // re-triangulate the hole with point i
      for (const e of edges) {
        triangles.push({ a: e.u, b: e.v, c: i });
      }
    }

    // remove triangles that reference super-triangle vertices
    triangles = triangles.filter(t => t.a < n && t.b < n && t.c < n);

    // remove degenerate (zero area) triangles
    triangles = triangles.filter(t => {
      const A = V[t.a], B = V[t.b], C = V[t.c];
      return Math.abs(triArea2(A,B,C)) > 1e-9;
    });

    return triangles;
  }

  // build PLY ascii string from points and triangles
  function buildPly(points3d, triangles) {
    const header = [
      "ply",
      "format ascii 1.0",
      `element vertex ${points3d.length}`,
      "property float x",
      "property float y",
      "property float z",
      `element face ${triangles.length}`,
      "property list uchar int vertex_indices",
      "end_header"
    ].join("\n");

    const verts = points3d.map(p => `${p.x} ${p.y} ${p.z}`).join("\n");
    const faces = triangles.map(t => `3 ${t.a} ${t.b} ${t.c}`).join("\n");

    return header + "\n" + verts + "\n" + faces + "\n";
  }

  // main function: convert and download
  function convertPointCloudToMeshAndDownload(points) {
    // points: array of {x,y,z}
    if (!points || !Array.isArray(points) || points.length === 0) {
      alert("Nenhuma nuvem de pontos válida para converter.");
      return;
    }
    if (points.length < 3) {
      alert("Pontos insuficientes para gerar uma malha (mínimo 3).");
      return;
    }

    // filter out invalid points and duplicates (simple)
    const filtered = [];
    const seen = new Set();
    for (const p of points) {
      if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) continue;
      const key = `${p.x.toFixed(6)}_${p.y.toFixed(6)}_${p.z.toFixed(6)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      filtered.push({ x: p.x, y: p.y, z: p.z });
    }
    if (filtered.length < 3) {
      alert("Pontos válidos insuficientes para gerar malha.");
      return;
    }

    // build 2D points for Delaunay (projecting on XY)
    const pts2d = filtered.map(p => ({ x: p.x, y: p.y }));

    // compute triangles (indices into filtered)
    let triangles;
    try {
      triangles = delaunayTriangles(pts2d);
    } catch (e) {
      console.error("Erro Delaunay:", e);
      alert("Erro ao triangulizar a nuvem de pontos.");
      return;
    }

    if (!triangles || triangles.length === 0) {
      alert("Não foi possível gerar triângulos a partir da nuvem.");
      return;
    }

    // build PLY
    const ply = buildPly(filtered, triangles);

    // download
    const blob = new Blob([ply], { type: "text/plain" });
    const fname = `mesh-${new Date().toISOString().replace(/[:.]/g,'-')}.ply`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // expose
  window.convertPointCloudToMeshAndDownload = convertPointCloudToMeshAndDownload;
})();
