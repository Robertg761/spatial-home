package expo.modules.arcorescanner

import android.opengl.GLES20
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer

internal object GlUtil {
  fun program(vertexSource: String, fragmentSource: String): Int {
    val program = GLES20.glCreateProgram()
    GLES20.glAttachShader(program, shader(GLES20.GL_VERTEX_SHADER, vertexSource))
    GLES20.glAttachShader(program, shader(GLES20.GL_FRAGMENT_SHADER, fragmentSource))
    GLES20.glLinkProgram(program)
    val status = IntArray(1)
    GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, status, 0)
    check(status[0] == GLES20.GL_TRUE) { "Shader program failed to link: ${GLES20.glGetProgramInfoLog(program)}" }
    return program
  }

  private fun shader(type: Int, source: String): Int {
    val shader = GLES20.glCreateShader(type)
    GLES20.glShaderSource(shader, source)
    GLES20.glCompileShader(shader)
    val status = IntArray(1)
    GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, status, 0)
    check(status[0] == GLES20.GL_TRUE) { "Shader failed to compile: ${GLES20.glGetShaderInfoLog(shader)}" }
    return shader
  }

  fun floatBuffer(capacity: Int): FloatBuffer =
    ByteBuffer.allocateDirect(capacity * Float.SIZE_BYTES).order(ByteOrder.nativeOrder()).asFloatBuffer()

  fun floatBuffer(values: FloatArray): FloatBuffer =
    floatBuffer(values.size).apply {
      put(values)
      position(0)
    }
}
