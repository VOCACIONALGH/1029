export function contarPixelsVermelhos(imageData) {
  let count = 0;
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    if (r > 150 && g < 100 && b < 100) {
      count++;
    }
  }

  return count;
}
