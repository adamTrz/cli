/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import execa from 'execa';
import fs from 'fs';
import {Config} from '@react-native-community/cli-types';
import adb from './adb';
import runOnAllDevices from './runOnAllDevices';
import tryRunAdbReverse from './tryRunAdbReverse';
import tryLaunchAppOnDevice from './tryLaunchAppOnDevice';
import getAdbPath from './getAdbPath';
import {logger, CLIError} from '@react-native-community/cli-tools';
import {getAndroidProject} from '../../config/getAndroidProject';
import listAndroidDevices from './listAndroidDevices';
import tryLaunchEmulator from './tryLaunchEmulator';
import chalk from 'chalk';
import {build, runPackager, BuildFlags, options} from '../buildAndroid';

export interface Flags extends BuildFlags {
  appId: string;
  appIdSuffix: string;
  mainActivity: string;
  deviceId?: string;
  listDevices?: boolean;
}

type AndroidProject = NonNullable<Config['project']['android']>;

/**
 * Starts the app on a connected Android emulator or device.
 */
async function runAndroid(_argv: Array<string>, config: Config, args: Flags) {
  const androidProject = getAndroidProject(config);

  await runPackager(args, config);
  return buildAndRun(args, androidProject);
}

const defaultPort = 5552;
async function getAvailableDevicePort(
  port: number = defaultPort,
): Promise<number> {
  /**
   * The default value is 5554 for the first virtual device instance running on your machine. A virtual device normally occupies a pair of adjacent ports: a console port and an adb port. The console of the first virtual device running on a particular machine uses console port 5554 and adb port 5555. Subsequent instances use port numbers increasing by two. For example, 5556/5557, 5558/5559, and so on. The range is 5554 to 5682, allowing for 64 concurrent virtual devices.
   */
  const adbPath = getAdbPath();
  const devices = adb.getDevices(adbPath);
  if (port > 5682) {
    throw new CLIError('Failed to launch emulator...');
  }
  if (devices.some((d) => d.includes(port.toString()))) {
    return await getAvailableDevicePort(port + 2);
  }
  return port;
}

// Builds the app and runs it on a connected emulator / device.
async function buildAndRun(args: Flags, androidProject: AndroidProject) {
  process.chdir(androidProject.sourceDir);
  const cmd = process.platform.startsWith('win') ? 'gradlew.bat' : './gradlew';

  const adbPath = getAdbPath();
  if (args.listDevices) {
    if (args.deviceId) {
      logger.warn(
        'Both "deviceId" and "list-devices" parameters were passed to "run" command. We will list available devices and let you choose from one',
      );
    }

    const device = await listAndroidDevices();
    if (!device) {
      return logger.error(
        'Failed to select device, please try to run app without --list-devices command',
      );
    }

    if (device.connected) {
      return runOnSpecificDevice(
        {...args, deviceId: device.deviceId},
        adbPath,
        androidProject,
      );
    }

    const port = await getAvailableDevicePort();
    const emulator = `emulator-${port}`;
    const result = await tryLaunchEmulator(adbPath, device.readableName, port);
    if (result.success) {
      logger.info('Successfully launched emulator.');
      return runOnSpecificDevice(
        {...args, deviceId: emulator},
        adbPath,
        androidProject,
      );
    } else {
      logger.error(
        `Failed to launch emulator. Reason: ${chalk.dim(result.error || '')}.`,
      );
      logger.warn(
        'Please launch an emulator manually or connect a device. Otherwise app may fail to launch.',
      );
    }
  }
  if (args.deviceId) {
    return runOnSpecificDevice(args, adbPath, androidProject);
  } else {
    return runOnAllDevices(args, cmd, adbPath, androidProject);
  }
}

function runOnSpecificDevice(
  args: Flags,
  adbPath: string,
  androidProject: AndroidProject,
) {
  const devices = adb.getDevices(adbPath);
  const {deviceId} = args;
  if (devices.length > 0 && deviceId) {
    if (devices.indexOf(deviceId) !== -1) {
      // using '-x lint' in order to ignore linting errors while building the apk
      let gradleArgs = ['build', '-x', 'lint'];
      if (args.extraParams) {
        gradleArgs = [...gradleArgs, ...args.extraParams];
      }
      build(gradleArgs, androidProject.sourceDir);
      installAndLaunchOnDevice(args, deviceId, adbPath, androidProject);
    } else {
      logger.error(
        `Could not find device with the id: "${deviceId}". Please choose one of the following:`,
        ...devices,
      );
    }
  } else {
    logger.error('No Android device or emulator connected.');
  }
}

function tryInstallAppOnDevice(
  args: Flags,
  adbPath: string,
  device: string,
  androidProject: AndroidProject,
) {
  try {
    // "app" is usually the default value for Android apps with only 1 app
    const {appName, sourceDir} = androidProject;
    const variant = (args.mode || 'debug').toLowerCase();
    const buildDirectory = `${sourceDir}/${appName}/build/outputs/apk/${variant}`;
    const apkFile = getInstallApkName(
      appName,
      adbPath,
      variant,
      device,
      buildDirectory,
    );

    const pathToApk = `${buildDirectory}/${apkFile}`;
    const adbArgs = ['-s', device, 'install', '-r', '-d', pathToApk];
    logger.info(`Installing the app on the device "${device}"...`);
    logger.debug(
      `Running command "cd android && adb -s ${device} install -r -d ${pathToApk}"`,
    );
    execa.sync(adbPath, adbArgs, {stdio: 'inherit'});
  } catch (error) {
    throw new CLIError('Failed to install the app on the device.', error);
  }
}

function getInstallApkName(
  appName: string,
  adbPath: string,
  variant: string,
  device: string,
  buildDirectory: string,
) {
  const availableCPUs = adb.getAvailableCPUs(adbPath, device);

  // check if there is an apk file like app-armeabi-v7a-debug.apk
  for (const availableCPU of availableCPUs.concat('universal')) {
    const apkName = `${appName}-${availableCPU}-${variant}.apk`;
    if (fs.existsSync(`${buildDirectory}/${apkName}`)) {
      return apkName;
    }
  }

  // check if there is a default file like app-debug.apk
  const apkName = `${appName}-${variant}.apk`;
  if (fs.existsSync(`${buildDirectory}/${apkName}`)) {
    return apkName;
  }

  throw new CLIError('Could not find the correct install APK file.');
}

function installAndLaunchOnDevice(
  args: Flags,
  selectedDevice: string,
  adbPath: string,
  androidProject: AndroidProject,
) {
  tryRunAdbReverse(args.port, selectedDevice);
  tryInstallAppOnDevice(args, adbPath, selectedDevice, androidProject);
  tryLaunchAppOnDevice(
    selectedDevice,
    androidProject.packageName,
    adbPath,
    args,
  );
}

export default {
  name: 'run-android',
  description:
    'builds your app and starts it on a connected Android emulator or device',
  func: runAndroid,
  options: [
    ...options,
    {
      name: '--appId <string>',
      description:
        'Specify an applicationId to launch after build. If not specified, `package` from AndroidManifest.xml will be used.',
      default: '',
    },
    {
      name: '--appIdSuffix <string>',
      description: 'Specify an applicationIdSuffix to launch after build.',
      default: '',
    },
    {
      name: '--main-activity <string>',
      description: 'Name of the activity to start',
      default: 'MainActivity',
    },
    {
      name: '--deviceId <string>',
      description:
        'builds your app and starts it on a specific device/simulator with the ' +
        'given device id (listed by running "adb devices" on the command line).',
    },
    {
      name: '--list-devices',
      description:
        'Will list all available Android devices and simulators and let you choose one to run the app',
      default: false,
    },
  ],
};
