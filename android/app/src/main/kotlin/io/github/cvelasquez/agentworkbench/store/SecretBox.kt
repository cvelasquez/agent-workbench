package io.github.cvelasquez.agentworkbench.store

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Cifra lo secreto que guarda el teléfono —la semilla de la llave SSH y la
 * credencial del equipo— con una llave AES del almacén de llaves de Android.
 * Esa llave no sale del teléfono ni viaja en un respaldo: lo cifrado sólo se
 * abre acá.
 */
object SecretBox {
    private const val ALIAS = "agent-workbench-secrets"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun key(): SecretKey {
        (keyStore().getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    /** Lo cifrado, con su vector al principio, en base64. */
    fun seal(plain: ByteArray): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        return Base64.getEncoder().encodeToString(cipher.iv + cipher.doFinal(plain))
    }

    /** Lo que se cifró, o null si no se puede abrir (otra llave, dato roto). */
    fun open(sealed: String): ByteArray? = runCatching {
        val bytes = Base64.getDecoder().decode(sealed)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, bytes, 0, IV_BYTES))
        cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES)
    }.getOrNull()

    /** Borra la llave: lo cifrado con ella ya no se abre nunca más. */
    fun destroy() {
        runCatching { keyStore().deleteEntry(ALIAS) }
    }
}
