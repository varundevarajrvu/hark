package dev.vector.app

import android.content.Context
import androidx.core.content.edit

/** The saved server origin. Only the origin string is stored; it is not a secret. */
object ServerStore {
    private const val FILE = "vector"
    private const val KEY_ORIGIN = "server_origin"

    fun load(context: Context): Origin? {
        val saved = context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY_ORIGIN, null)
        return saved?.let { Origin.of(it) }
    }

    fun save(context: Context, origin: Origin) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit {
            putString(KEY_ORIGIN, origin.toString())
        }
    }
}
