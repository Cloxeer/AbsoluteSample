# pitchcore assets

- `crepe_tiny.bin`: weights of the CREPE "tiny" pitch model (Kim, Salamon, Li, Bello, 2018),
  converted from torchcrepe's `tiny.pth` (MIT license, https://github.com/maxrmorrison/torchcrepe,
  original model https://github.com/marl/crepe, MIT). Flat little-endian f32. For each of the
  6 conv layers: weight[out][in][k], bias[out], bn_scale[out], bn_shift[out]; then the classifier
  weight[360][256], bias[360]. Batch-norm is applied after ReLU as `x*scale+shift`.
- `crepe_tiny_ref.bin`: one 1024-sample test frame followed by the 360 activations PyTorch
  produces for it; `src/crepe.rs` tests that the Rust network matches.
