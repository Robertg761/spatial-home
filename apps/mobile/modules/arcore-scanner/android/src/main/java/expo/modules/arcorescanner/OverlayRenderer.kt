package expo.modules.arcorescanner

import android.opengl.GLES20
import java.nio.FloatBuffer

/**
 * Draws lines and dots in the AR world over the camera image: the detected floor, the corners
 * placed so far, the walls between them, and where the next corner would go.
 */
internal class OverlayRenderer {
  private var program = 0
  private var positionAttribute = 0
  private var mvpUniform = 0
  private var colorUniform = 0
  private var pointSizeUniform = 0
  private var buffer: FloatBuffer = GlUtil.floatBuffer(3 * 256)

  fun create() {
    program = GlUtil.program(VERTEX_SHADER, FRAGMENT_SHADER)
    positionAttribute = GLES20.glGetAttribLocation(program, "a_Position")
    mvpUniform = GLES20.glGetUniformLocation(program, "u_ModelViewProjection")
    colorUniform = GLES20.glGetUniformLocation(program, "u_Color")
    pointSizeUniform = GLES20.glGetUniformLocation(program, "u_PointSize")
  }

  /** Draws `points` (x, y, z triples in world space) with an OpenGL primitive such as GL_LINES. */
  fun draw(
    mode: Int,
    points: FloatArray,
    viewProjection: FloatArray,
    color: FloatArray,
    lineWidth: Float = 4f,
    pointSize: Float = 18f,
  ) {
    if (points.isEmpty()) return
    if (buffer.capacity() < points.size) buffer = GlUtil.floatBuffer(points.size * 2)
    buffer.clear()
    buffer.put(points)
    buffer.position(0)

    GLES20.glUseProgram(program)
    // Drawn on top of the camera image without depth testing: the overlay has no idea what real
    // objects stand in front of it, so it always shows.
    GLES20.glDisable(GLES20.GL_DEPTH_TEST)
    GLES20.glEnable(GLES20.GL_BLEND)
    GLES20.glBlendFunc(GLES20.GL_SRC_ALPHA, GLES20.GL_ONE_MINUS_SRC_ALPHA)
    GLES20.glUniformMatrix4fv(mvpUniform, 1, false, viewProjection, 0)
    GLES20.glUniform4fv(colorUniform, 1, color, 0)
    GLES20.glUniform1f(pointSizeUniform, pointSize)
    GLES20.glLineWidth(lineWidth)
    GLES20.glVertexAttribPointer(positionAttribute, 3, GLES20.GL_FLOAT, false, 0, buffer)
    GLES20.glEnableVertexAttribArray(positionAttribute)
    GLES20.glDrawArrays(mode, 0, points.size / 3)
    GLES20.glDisableVertexAttribArray(positionAttribute)
    GLES20.glDisable(GLES20.GL_BLEND)
    GLES20.glEnable(GLES20.GL_DEPTH_TEST)
  }

  private companion object {
    const val VERTEX_SHADER = """
      uniform mat4 u_ModelViewProjection;
      uniform float u_PointSize;
      attribute vec4 a_Position;
      void main() {
        gl_Position = u_ModelViewProjection * a_Position;
        gl_PointSize = u_PointSize;
      }
    """

    const val FRAGMENT_SHADER = """
      precision mediump float;
      uniform vec4 u_Color;
      void main() {
        gl_FragColor = u_Color;
      }
    """
  }
}
