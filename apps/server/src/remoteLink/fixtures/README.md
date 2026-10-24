# Noise interoperability fixtures

`cacophony.json` contains only the XX and KK X25519/ChaChaPoly/SHA256 vectors
from [Cacophony](https://github.com/haskell-cryptography/cacophony/blob/8ee9d41e34a1a596cfa3ab12aa4069ff87dc1247/vectors/cacophony.txt),
commit `8ee9d41e34a1a596cfa3ab12aa4069ff87dc1247`. That project is released
under the [Unlicense](https://github.com/haskell-cryptography/cacophony/blob/8ee9d41e34a1a596cfa3ab12aa4069ff87dc1247/LICENSE).
The fixture keys are public test inputs, not device credentials.

Penkra implements the [Noise specification, revision 34](https://noiseprotocol.org/noise.html).
Tests compare every handshake and transport ciphertext and the final handshake
hash, rather than merely round-tripping two copies of the same implementation.
