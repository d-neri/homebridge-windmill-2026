import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { WindmillDeviceConfig, WindmillPlatform } from './platform.js';
import { FanSpeed, Mode, WindmillService } from './services/WindmillService.js';
import { celsiusToFahrenheit, fahrenheitToCelsius } from './helpers/temperature.js';

interface WindmillState {
  power: boolean;
  currentTemperature: number;
  targetTemperature: number;
  mode: Mode;
  fanSpeed: FanSpeed;
}

const DEFAULT_POLL_INTERVAL = 30;

export class WindmillAccessory {
  private readonly windmill: WindmillService;
  private readonly thermostatService: Service;
  private readonly fanService: Service;
  private displayUnits: number;
  private pollTimer?: ReturnType<typeof setInterval>;

  private state: WindmillState = {
    power: false,
    currentTemperature: 72,
    targetTemperature: 72,
    mode: Mode.COOL,
    fanSpeed: FanSpeed.AUTO,
  };

  constructor(
    private readonly platform: WindmillPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const device = accessory.context.device as WindmillDeviceConfig;

    this.displayUnits = this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
    this.windmill = new WindmillService(device.token, this.platform.log);

    // Accessory Information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'The Air Lab, Inc.')
      .setCharacteristic(this.platform.Characteristic.Model, 'Windmill AC')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'Default');

    // Thermostat Service
    this.thermostatService = this.accessory.getService(this.platform.Service.Thermostat)
      || this.accessory.addService(this.platform.Service.Thermostat);

    this.thermostatService.setCharacteristic(this.platform.Characteristic.Name, device.name);

    this.thermostatService.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentHeatingCoolingState.bind(this));

    this.thermostatService.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(this.getTargetHeatingCoolingState.bind(this))
      .onSet(this.setTargetHeatingCoolingState.bind(this));

    this.thermostatService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getCurrentTemperature.bind(this));

    this.thermostatService.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .setProps({
        minValue: fahrenheitToCelsius(60),
        maxValue: fahrenheitToCelsius(86),
        minStep: 1,
      })
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTargetTemperature.bind(this));

    this.thermostatService.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(this.getTemperatureDisplayUnits.bind(this))
      .onSet(this.setTemperatureDisplayUnits.bind(this));

    // Fan Service
    this.fanService = this.accessory.getService(this.platform.Service.Fanv2)
      || this.accessory.addService(this.platform.Service.Fanv2);

    this.fanService.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.getFanActive.bind(this))
      .onSet(this.setFanActive.bind(this));

    this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onGet(this.getFanRotationSpeed.bind(this))
      .onSet(this.setFanRotationSpeed.bind(this));

    // Set thermostat as primary
    this.thermostatService.setPrimaryService(true);

    // Start polling
    const interval = (this.platform.config.pollInterval ?? DEFAULT_POLL_INTERVAL) * 1000;
    this.refreshState();
    this.pollTimer = setInterval(() => this.refreshState(), interval);

    this.platform.api.on('shutdown', () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
      }
    });
  }

  private async refreshState(): Promise<void> {
    try {
      const [power, currentTemperature, targetTemperature, mode, fanSpeed] = await Promise.all([
        this.windmill.getPower(),
        this.windmill.getCurrentTemperature(),
        this.windmill.getTargetTemperature(),
        this.windmill.getMode(),
        this.windmill.getFanSpeed(),
      ]);

      this.state = { power, currentTemperature, targetTemperature, mode, fanSpeed };

      // Push updated values to HomeKit
      this.thermostatService.updateCharacteristic(
        this.platform.Characteristic.CurrentHeatingCoolingState,
        this.getCurrentHeatingCoolingState(),
      );
      this.thermostatService.updateCharacteristic(
        this.platform.Characteristic.TargetHeatingCoolingState,
        this.getTargetHeatingCoolingState(),
      );
      this.thermostatService.updateCharacteristic(
        this.platform.Characteristic.CurrentTemperature,
        this.getCurrentTemperature(),
      );
      this.thermostatService.updateCharacteristic(
        this.platform.Characteristic.TargetTemperature,
        this.getTargetTemperature(),
      );
      this.fanService.updateCharacteristic(
        this.platform.Characteristic.Active,
        this.getFanActive(),
      );
      this.fanService.updateCharacteristic(
        this.platform.Characteristic.RotationSpeed,
        this.getFanRotationSpeed(),
      );
    } catch (e) {
      this.platform.log.warn('Failed to refresh state for %s: %s', this.accessory.displayName, e);
    }
  }

  // --- Thermostat Handlers ---

  getCurrentHeatingCoolingState(): CharacteristicValue {
    if (!this.state.power) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }

    switch (this.state.mode) {
    case Mode.COOL:
    case Mode.ECO:
      return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
    case Mode.FAN:
      return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
    }
  }

  getTargetHeatingCoolingState(): CharacteristicValue {
    if (!this.state.power) {
      return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
    }

    switch (this.state.mode) {
    case Mode.COOL:
      return this.platform.Characteristic.TargetHeatingCoolingState.COOL;
    case Mode.FAN:
      return this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
    case Mode.ECO:
      return this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
    }
  }

  async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    this.platform.log.debug('SET TargetHeatingCoolingState:', value);

    if (value === this.platform.Characteristic.TargetHeatingCoolingState.OFF) {
      await this.windmill.setPower(false);
      this.state.power = false;
      this.fanService.updateCharacteristic(this.platform.Characteristic.Active, false);
      return;
    }

    await this.windmill.setPower(true);
    this.state.power = true;

    switch (value) {
    case this.platform.Characteristic.TargetHeatingCoolingState.COOL:
      await this.windmill.setMode(Mode.COOL);
      this.state.mode = Mode.COOL;
      break;
    case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
      await this.windmill.setMode(Mode.FAN);
      this.state.mode = Mode.FAN;
      break;
    case this.platform.Characteristic.TargetHeatingCoolingState.AUTO:
      await this.windmill.setMode(Mode.ECO);
      this.state.mode = Mode.ECO;
      break;
    }

    await this.windmill.setFanSpeed(this.state.fanSpeed);
  }

  getCurrentTemperature(): CharacteristicValue {
    return fahrenheitToCelsius(this.state.currentTemperature);
  }

  getTargetTemperature(): CharacteristicValue {
    return fahrenheitToCelsius(this.state.targetTemperature);
  }

  async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    this.platform.log.debug('SET TargetTemperature:', value);
    const fahrenheit = celsiusToFahrenheit(parseFloat(value.toString()));
    await this.windmill.setTargetTemperature(fahrenheit);
    this.state.targetTemperature = Math.round(fahrenheit);
  }

  getTemperatureDisplayUnits(): CharacteristicValue {
    return this.displayUnits;
  }

  setTemperatureDisplayUnits(value: CharacteristicValue): void {
    this.displayUnits = parseInt(value.toString(), 10);
  }

  // --- Fan Handlers ---

  getFanActive(): CharacteristicValue {
    if (!this.state.power || this.state.fanSpeed === FanSpeed.AUTO) {
      return this.platform.Characteristic.Active.INACTIVE;
    }
    return this.platform.Characteristic.Active.ACTIVE;
  }

  async setFanActive(value: CharacteristicValue): Promise<void> {
    this.platform.log.debug('SET FanActive:', value);

    if (value === this.platform.Characteristic.Active.INACTIVE) {
      await this.windmill.setFanSpeed(FanSpeed.AUTO);
      this.state.fanSpeed = FanSpeed.AUTO;
    }
  }

  getFanRotationSpeed(): CharacteristicValue {
    if (!this.state.power) {
      return 0;
    }

    switch (this.state.fanSpeed) {
    case FanSpeed.AUTO:
      return 0;
    case FanSpeed.LOW:
      return 33;
    case FanSpeed.MEDIUM:
      return 66;
    case FanSpeed.HIGH:
      return 100;
    }
  }

  async setFanRotationSpeed(value: CharacteristicValue): Promise<void> {
    this.platform.log.debug('SET FanRotationSpeed:', value);

    const intValue = parseInt(value.toString(), 10);

    if (intValue === 0) {
      return;
    }

    if (intValue <= 33) {
      await this.windmill.setFanSpeed(FanSpeed.LOW);
      this.state.fanSpeed = FanSpeed.LOW;
    } else if (intValue <= 66) {
      await this.windmill.setFanSpeed(FanSpeed.MEDIUM);
      this.state.fanSpeed = FanSpeed.MEDIUM;
    } else {
      await this.windmill.setFanSpeed(FanSpeed.HIGH);
      this.state.fanSpeed = FanSpeed.HIGH;
    }
  }
}
