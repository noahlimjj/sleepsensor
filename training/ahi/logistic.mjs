// Small logistic regression (batch gradient descent with L2).
export function fit(X, y, { iters = 3000, lr = 0.3, l2 = 0.01 } = {}) {
  const n = X[0].length;
  const w = new Float64Array(n + 1);
  for (let it = 0; it < iters; it++) {
    const g = new Float64Array(n + 1);
    for (let r = 0; r < X.length; r++) {
      let z = w[n];
      for (let k = 0; k < n; k++) z += w[k] * X[r][k];
      const e = 1 / (1 + Math.exp(-z)) - y[r];
      for (let k = 0; k < n; k++) g[k] += e * X[r][k];
      g[n] += e;
    }
    for (let k = 0; k < n; k++) w[k] -= lr * (g[k] / X.length + l2 * w[k]);
    w[n] -= (lr * g[n]) / X.length;
  }
  return w;
}
export const prob = (w, f) => {
  let z = w[f.length];
  for (let k = 0; k < f.length; k++) z += w[k] * f[k];
  return 1 / (1 + Math.exp(-z));
};
