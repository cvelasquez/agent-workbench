package io.github.cvelasquez.agentworkbench.ui

import android.content.Context
import io.github.cvelasquez.agentworkbench.R
import io.github.cvelasquez.agentworkbench.tunnel.TunnelProblem

/** Qué se le dice al usuario de cada problema de la conexión. */
object Texts {
    fun problem(context: Context, problem: TunnelProblem): String = when (problem) {
        TunnelProblem.PcNotFound -> context.getString(R.string.problem_pc_not_found)
        TunnelProblem.SshClosed -> context.getString(R.string.problem_ssh_closed)
        TunnelProblem.KeyRejected -> context.getString(R.string.problem_key_rejected)
        is TunnelProblem.HostKeyChanged -> context.getString(R.string.problem_host_key_changed, problem.fingerprint)
        TunnelProblem.AppNotRunning -> context.getString(R.string.problem_app_not_running)
        TunnelProblem.NotAccepted -> context.getString(R.string.problem_not_accepted)
        is TunnelProblem.LocalPortBusy -> context.getString(R.string.problem_local_port_busy, problem.port)
        TunnelProblem.NotPaired -> context.getString(R.string.problem_not_paired)
        is TunnelProblem.Other -> context.getString(R.string.problem_other, problem.detail)
    }

    /** La dirección pública de la política de privacidad, que Play pide. */
    const val PRIVACY_URL = "https://github.com/cvelasquez/agent-workbench/blob/main/PRIVACY.md"
}
