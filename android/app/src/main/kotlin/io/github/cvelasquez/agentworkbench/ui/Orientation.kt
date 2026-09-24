package io.github.cvelasquez.agentworkbench.ui

import android.app.Activity
import android.content.pm.ActivityInfo

/**
 * En un teléfono, sólo vertical. Acostado pasa de 768 px y la web dibuja la vista
 * de la PC, que en ese alto no entra. Una tablet gira libre: ahí la vista de la
 * PC sí cabe.
 *
 * Se decide al ejecutar y no en el manifiesto: `screenOrientation` no distingue
 * tablets, y desde Android 16 el sistema lo ignora en pantallas grandes pero no
 * en las anteriores. 600 dp de ancho mínimo es el corte de Android para tablet.
 * El lector del QR no pasa por acá: gira con el teléfono a propósito.
 */
object Orientation {
    private const val TABLET_MIN_WIDTH_DP = 600

    fun apply(activity: Activity) {
        val phone = activity.resources.configuration.smallestScreenWidthDp < TABLET_MIN_WIDTH_DP
        val wanted = if (phone) ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        if (activity.requestedOrientation != wanted) activity.requestedOrientation = wanted
    }
}
