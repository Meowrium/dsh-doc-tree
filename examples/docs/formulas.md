# 公式渲染验证

行内公式：质能方程 $E = mc^2$，欧拉恒等式 $e^{i\pi} + 1 = 0$。

## 分式与根号

$$
\frac{\partial \mathcal{L}}{\partial \theta}
= \frac{1}{N}\sum_{i=1}^{N}\left(\hat{y}_i - y_i\right)^2
+ \lambda \lVert \theta \rVert_2^2
$$

## 矩阵与对齐

$$
\begin{aligned}
\nabla_\theta J(\theta) &= \frac{1}{m}\sum_{i=1}^{m}\left(h_\theta(x^{(i)}) - y^{(i)}\right)x^{(i)} \
\theta &:= \theta - \eta \nabla_\theta J(\theta)
\end{aligned}
$$

$$
\mathbf{K} =
\begin{bmatrix}
k(x_1,x_1) & \cdots & k(x_1,x_n) \
\vdots & \ddots & \vdots \
k(x_n,x_1) & \cdots & k(x_n,x_n)
\end{bmatrix}
$$

## 表格与引用

| 模型 | 参数量 | 困惑度 |
|---|---:|---:|
| Small | 124M | 18.4 |
| Base | 355M | 12.7 |

> 公式块之间需要空行；`$$` 独占一行时按 display math 渲染。

```python
loss = ((y_hat - y) ** 2).mean() + lam * (theta ** 2).sum()
```
