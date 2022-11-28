import os from 'os';
import execa from 'execa';
import Adb from './adb';

const emulatorCommand = process.env.ANDROID_HOME
  ? `${process.env.ANDROID_HOME}/emulator/emulator`
  : 'emulator';

export const getEmulators = () => {
  try {
    const emulatorsOutput = execa.sync(emulatorCommand, ['-list-avds']).stdout;
    return emulatorsOutput.split(os.EOL).filter((name) => name !== '');
  } catch {
    return [];
  }
};

export const launchEmulator = async (
  emulatorName: string,
  adbPath: string,
  port?: string,
) => {
  console.log('emulatorNAme', emulatorName);
  console.log('port', port);
  return new Promise((resolve, reject) => {
    const cp = execa(
      emulatorCommand,
      [`@${emulatorName}`, port ? '-port' : '', port ? `${port}` : ''],
      {
        detached: true,
        stdio: 'ignore',
      },
    );
    cp.unref();
    const timeout = 30;

    // Reject command after timeout
    const rejectTimeout = setTimeout(() => {
      cleanup();
      reject(`Could not start emulator within ${timeout} seconds.`);
    }, timeout * 1000);

    const bootCheckInterval = setInterval(() => {
      if (Adb.getDevices(adbPath).length > 0) {
        cleanup();
        resolve();
      }
    }, 1000);

    const cleanup = () => {
      clearTimeout(rejectTimeout);
      clearInterval(bootCheckInterval);
    };

    cp.on('exit', () => {
      cleanup();
      reject('Emulator exited before boot.');
    });

    cp.on('error', (error) => {
      cleanup();
      reject(error.message);
    });
  });
};

export default async function tryLaunchEmulator(
  adbPath: string,
  emulatorName?: string,
  port?: string,
): Promise<{success: boolean; error?: string}> {
  const emulators = getEmulators();
  if (emulators.length > 0) {
    try {
      await launchEmulator(emulatorName ?? emulators[0], adbPath, port);
      return {success: true};
    } catch (error) {
      return {success: false, error};
    }
  }
  return {
    success: false,
    error: 'No emulators found as an output of `emulator -list-avds`',
  };
}
