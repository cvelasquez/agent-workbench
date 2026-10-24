# Las reglas de R8 de la compilación de Play (§15.11). Sólo lo que una biblioteca
# busca por su nombre: lo demás lo resuelve R8 siguiendo el código, y OkHttp, Okio,
# Kotlin y androidx traen sus propias reglas. Cada regla dice qué rompe sin ella.

# sshlib arma el cifrado del túnel por nombre: BlockCipherFactory hace
# Class.forName("com.trilead.ssh2.crypto.cipher.AES$CTR").getConstructor().newInstance(),
# y lo mismo con ChaCha20Poly1305, AesGcm, BlowFish y DESede. Sin esto R8 las
# renombra o las borra, y la conexión con la PC no negocia ningún cifrado.
-keep class com.trilead.ssh2.crypto.cipher.** { *; }

# Lo mismo con la compresión: CompressionFactory pide "com.trilead.ssh2.compression.Zlib"
# y "...ZlibOpenSSH" por nombre. El túnel no la pide, pero sshlib la ofrece si el
# servidor la propone.
-keep class com.trilead.ssh2.compression.** { *; }
