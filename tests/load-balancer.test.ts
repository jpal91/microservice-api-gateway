import { RoundRobinBalancer } from "@app/load-balancer";
import type { Instance } from "microservice-ecommerce";
import { randomUUID } from "node:crypto";

const getInstances = (service: string = "something"): Instance[] => {
  return Array.from({ length: 3 }).map((_, i) => {
    return {
      id: randomUUID(),
      token: "askldjfksj",
      serviceType: service,
      host: "localhost",
      port: "3000",
      created: Date.now(),
      lastUpdated: Date.now(),
      healthy: true,
    };
  });
};

describe("RoundRobin", () => {
  let instances: Instance[];
  let robin: RoundRobinBalancer;

  beforeEach(() => {
    robin = new RoundRobinBalancer();
    instances = getInstances();
  });

  test("it defaults to the first", () => {
    const choice = robin.selectInstance(instances);
    expect(choice.id).toBe(instances[0].id);
  });

  test("it goes in order", () => {
    // Go through each and loop around to verify it picks the first again
    for (let i = 0; i < instances.length + 1; i++) {
      const choice = robin.selectInstance(instances);
      expect(choice.id).toBe(instances[i % instances.length].id);
    }
  });

  test("it chooses based on serviceType", () => {
    const instances2 = getInstances("something-else");

    let pick1: Instance;
    Array.from({ length: instances.length }).forEach(() => {
      pick1 = robin.selectInstance(instances);
    });

    const pick2 = robin.selectInstance(instances2);

    const p1Idx = instances.findIndex((inst) => inst.id === pick1.id);
    const p2Idx = instances2.findIndex((inst) => inst.id === pick2.id);

    expect(p1Idx).toBe(2);
    expect(p2Idx).toBe(0);
  });

  test("it doesn't error if the next pick is removed", () => {
    // The next pick should be the last in the array
    Array.from({ length: instances.length - 1 }).forEach(() => {
      robin.selectInstance(instances);
    });

    // Remove what should be the next pick
    instances.pop();

    const pick = robin.selectInstance(instances);
    expect(pick.id).toBe(instances[0].id);
  });
});
