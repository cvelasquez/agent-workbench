import java.nio.ByteBuffer
import java.nio.ByteOrder

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.cvelasquez.agentworkbench"
    compileSdk = 36

    defaultConfig {
        // Queda fijo para siempre con la primera subida a Play (docs/plan-hito-38.md, N4).
        applicationId = "io.github.cvelasquez.agentworkbench"
        minSdk = 29
        // Play exige la API 36 para apps nuevas y actualizaciones desde el 31-08-2026.
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        debug {
            // La de desarrollo convive en el mismo teléfono con la publicada.
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
        }
        release {
            // Sin achicar todavía: sshlib y Tink registran proveedores por nombre,
            // y las reglas para conservarlos se escriben y se prueban al publicar.
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    packaging {
        resources.excludes += setOf(
            "META-INF/*.md",
            "META-INF/LICENSE*",
            "META-INF/NOTICE*",
            "META-INF/DEPENDENCIES",
            "META-INF/INDEX.LIST",
            "META-INF/versions/9/OSGI-INF/MANIFEST.MF",
        )
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

/**
 * Los dos sonidos de los avisos, "terminó" y "te espera": los mismos de la web
 * (`CHIMES` de `packages/web/src/notification-sound.ts`), escritos como WAV al
 * compilar. Como en la web, en el repositorio no hay ningún archivo de audio,
 * sólo las notas.
 *
 * La diferencia es el volumen: la web suena bajo y el usuario lo sube con su
 * barrita; acá el archivo va al máximo sin saturar, y manda el volumen de
 * notificaciones del teléfono, que la app no puede pasar.
 */
abstract class ChimeSoundsTask : DefaultTask() {
    @get:OutputDirectory
    abstract val outputDirectory: DirectoryProperty

    private data class Note(val frequency: Double, val at: Double, val duration: Double)

    @TaskAction
    fun write() {
        val raw = outputDirectory.get().dir("raw").asFile.apply { mkdirs() }
        // Si cambian las notas de la web, cambian acá.
        val chimes = mapOf(
            "chime_done" to listOf(Note(880.0, 0.0, 0.18), Note(659.25, 0.14, 0.28)),
            "chime_attention" to listOf(Note(659.25, 0.0, 0.18), Note(987.77, 0.14, 0.28)),
        )
        for ((name, notes) in chimes) raw.resolve("$name.wav").writeBytes(wav(synthesize(notes)))
    }

    /** Las mismas envolventes que la web: ataque de 12 ms y caída exponencial hasta la duración. */
    private fun synthesize(notes: List<Note>): DoubleArray {
        val floor = 0.0001
        val attack = 0.012
        val length = notes.maxOf { it.at + it.duration } + 0.02
        val samples = DoubleArray((length * SAMPLE_RATE).toInt())
        for (note in notes) {
            val first = (note.at * SAMPLE_RATE).toInt()
            val last = minOf(samples.size, ((note.at + note.duration + 0.02) * SAMPLE_RATE).toInt())
            for (index in first until last) {
                val t = index.toDouble() / SAMPLE_RATE - note.at
                val gain = when {
                    t < attack -> floor * Math.pow(1.0 / floor, t / attack)
                    t < note.duration -> Math.pow(floor, (t - attack) / (note.duration - attack))
                    else -> 0.0
                }
                samples[index] += gain * Math.sin(2 * Math.PI * note.frequency * t)
            }
        }
        val peak = samples.maxOf { Math.abs(it) }
        return DoubleArray(samples.size) { samples[it] / peak * 0.95 }
    }

    /** PCM de 16 bits, mono. */
    private fun wav(samples: DoubleArray): ByteArray {
        val data = samples.size * 2
        val buffer = ByteBuffer.allocate(44 + data).order(ByteOrder.LITTLE_ENDIAN)
        buffer.put("RIFF".toByteArray()).putInt(36 + data).put("WAVE".toByteArray())
        buffer.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1)
            .putInt(SAMPLE_RATE).putInt(SAMPLE_RATE * 2).putShort(2).putShort(16)
        buffer.put("data".toByteArray()).putInt(data)
        for (sample in samples) buffer.putShort((sample * Short.MAX_VALUE).toInt().toShort())
        return buffer.array()
    }

    private companion object {
        const val SAMPLE_RATE = 44_100
    }
}

val chimeSounds = tasks.register<ChimeSoundsTask>("chimeSounds")

androidComponents {
    onVariants { variant ->
        variant.sources.res?.addGeneratedSourceDirectory(chimeSounds, ChimeSoundsTask::outputDirectory)
    }
}

dependencies {
    // El túnel SSH: la biblioteca de ConnectBot, Apache-2.0, sin BouncyCastle (S2).
    implementation("org.connectbot:sshlib:2.2.48")
    // La misma que trae sshlib, que la declara sólo para ejecutar: la llave del
    // teléfono se deriva de su semilla con Tink (SshSession.keyPair).
    implementation("com.google.crypto.tink:tink:1.21.0")
    // El WebSocket del vigía y los pedidos por el túnel.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Leer el QR para emparejar, sin los servicios de Google.
    implementation("com.journeyapps:zxing-android-embedded:4.3.0") { isTransitive = false }
    implementation("com.google.zxing:core:3.5.4")
    // El lector pide la cámara con ContextCompat y ActivityCompat, pero su POM no declara
    // androidx.core: sin esta línea, "Escanear código" cierra la app con un
    // NoClassDefFoundError (visto en la prueba de punta a punta).
    implementation("androidx.core:core:1.13.1")

    testImplementation("junit:junit:4.13.2")
    // android.jar trae org.json sólo como esqueleto: las pruebas en la JVM necesitan la de verdad.
    testImplementation("org.json:json:20240303")
}
