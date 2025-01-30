import type { Instance } from "microservice-ecommerce";

/**
 * Simple Round Robin load balancing strategy.
 *
 * Keeps track of each service and the last index selected for that service and rotates through.
 */
export class RoundRobinBalancer {
  serviceTypes: Map<string, number>;

  constructor() {
    this.serviceTypes = new Map();
  }

  selectInstance(instances: Instance[]) {
    const type = instances[0].serviceType;
    let idx = this.serviceTypes.get(type) ?? 0;

    if (idx > instances.length - 1) {
      idx = 0;
    }

    // In case an instance has been marked unhealthy at some point, we clamp
    const instance = instances[idx];
    this.serviceTypes.set(type, (idx + 1) % instances.length);

    return instance;
  }
}

/**
 * Simple random load balancing strategy. Just picks a random instance and returns;
 */
export class RandomBalancer {
  selectInstance(instances: Instance[]) {
    const randomIdx = Math.floor(Math.random() * instances.length);
    return instances[randomIdx];
  }
}
