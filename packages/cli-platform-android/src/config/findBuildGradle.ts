import path from 'path';
import glob from 'glob';

export function findBuildGradle(sourceDir: string) {
  const gradlePath = glob.sync('**/+(build.gradle|build.gradle.kts)', {
    cwd: sourceDir,
    ignore: [
      'node_modules/**',
      '**/build/**',
      '**/debug/**',
      'Examples/**',
      'examples/**',
    ],
  })[0];

  return gradlePath ? path.join(sourceDir, gradlePath) : null;
}
