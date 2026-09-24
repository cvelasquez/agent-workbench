package io.github.cvelasquez.agentworkbench.ui

import android.app.Activity
import android.os.Build
import android.view.View
import android.view.WindowInsets
import kotlin.math.max

/**
 * De borde a borde en todas las versiones que lo permiten (API 30 en adelante;
 * desde la 35 Android lo impone): cada pantalla se aparta sola de las barras del
 * sistema, del recorte de la cámara y del teclado.
 *
 * Medido en el hito (S1): con la ventana de borde a borde, `adjustResize` ya no
 * achica el visor cuando aparece el teclado, y el cuadro de escritura quedaba
 * tapado. Apartar la vista del teclado a mano es lo que lo arregla.
 *
 * El margen va en el contenedor del contenido, no en la vista de la pantalla:
 * así la vista se achica de verdad. Un `ScrollView` con el margen puesto en sí
 * mismo no cambia de alto, y lleva el campo con el foco a la vista sin contar
 * su propio margen: el campo quedaba debajo del teclado (visto en la prueba de
 * punta a punta, al pegar el texto del código).
 *
 * Los insets se consumen: el visor no los recibe, así la web no suma otra vez
 * `env(safe-area-inset-*)` encima de este margen.
 */
fun Activity.edgeToEdge() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
    window.setDecorFitsSystemWindows(false)
    val content = findViewById<View>(android.R.id.content)
    content.setOnApplyWindowInsetsListener { view, insets ->
        val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
        val ime = insets.getInsets(WindowInsets.Type.ime())
        view.setPadding(bars.left, bars.top, bars.right, max(bars.bottom, ime.bottom))
        WindowInsets.CONSUMED
    }
    content.requestApplyInsets()
}
