package io.github.cvelasquez.agentworkbench.tunnel

/**
 * Qué contesta en una dirección que el usuario escribió en Ajustes ("Cambiar
 * dirección", §15.4): la PC emparejada, otro equipo o nada. Se mira antes de
 * guardarla, con la huella fijada al emparejar: así una dirección equivocada no
 * deja a la app frenada en "la huella cambió", que pide emparejar de nuevo.
 */
sealed class AddressCheck {
    data object SamePc : AddressCheck()

    /** Contesta un SSH con otra huella: no es la PC emparejada. */
    data class OtherPc(val fingerprint: String) : AddressCheck()

    data class Unreachable(val problem: TunnelProblem) : AddressCheck()

    companion object {
        /**
         * Prueba las direcciones en orden y para en la primera que es la PC. Si
         * ninguna lo es, otro equipo dice más que nada: esa dirección contesta,
         * pero no es la nuestra. Si nada contesta, lo que pasó con la primera.
         */
        fun firstMatch(hosts: List<String>, check: (String) -> AddressCheck): Pair<String, AddressCheck> {
            var first: Pair<String, AddressCheck>? = null
            var other: Pair<String, AddressCheck>? = null
            for (host in hosts) {
                val result = check(host)
                if (result is SamePc) return host to result
                if (result is OtherPc && other == null) other = host to result
                if (first == null) first = host to result
            }
            return requireNotNull(other ?: first) { "sin direcciones" }
        }
    }
}
