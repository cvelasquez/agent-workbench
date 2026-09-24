package io.github.cvelasquez.agentworkbench.ui

import android.os.Bundle
import com.journeyapps.barcodescanner.CaptureActivity

/**
 * El lector de ZXing, apartado de las barras del sistema como las demás
 * pantallas (Insets.kt). Con targetSdk 35 o más Android dibuja toda ventana de
 * borde a borde, también la de la biblioteca, y su instrucción, que va abajo,
 * quedaba debajo de la barra de navegación (visto en la prueba de punta a punta).
 */
class ScanActivity : CaptureActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        edgeToEdge()
    }
}
