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
