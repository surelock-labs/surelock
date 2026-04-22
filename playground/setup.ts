import hre from 'hardhat'
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers'
import type { QuoteRegistry, SLAEscrow, MockEntryPoint } from '../typechain-types'
import type { TimelockController } from '../typechain-types/@openzeppelin/contracts/governance/TimelockController'

export interface PlaygroundContext {
  registry: QuoteRegistry
  escrow: SLAEscrow
  registryAddress: string
  escrowAddress: string
  entryPoint: MockEntryPoint
  owner: HardhatEthersSigner
}

export interface TimelockContext extends PlaygroundContext {
  timelock: TimelockController
  timelockAddress: string
  /** Delay in seconds passed to setupWithTimelock(). */
  timelockDelay: number
}

/**
 * Deploy QuoteRegistry + SLAEscrow (UUPS proxy, no Timelock) on the local network.
 * Signer layout: [0]=owner [1]=client1 [2]=bundler1 [3]=attacker [4]=client2 [5]=bundler2
 *
 * Run via:
 *   npx hardhat run examples/happy.ts --network hardhat
 *   npx hardhat run examples/happy.ts --network localhost   (needs: npx hardhat node)
 */
export async function setup(): Promise<PlaygroundContext> {
  const [owner] = await hre.ethers.getSigners()

  // Deploy MockEntryPoint (playground stub -- emits UserOperationEvent for settle proofs)
  const MockEPFactory = await hre.ethers.getContractFactory('MockEntryPoint')
  const entryPoint = (await MockEPFactory.deploy()) as unknown as MockEntryPoint
  await entryPoint.waitForDeployment()
  const entryPointAddress = await entryPoint.getAddress()

  // Deploy QuoteRegistry
  const RegistryFactory = await hre.ethers.getContractFactory('QuoteRegistry')
  const registry = (await RegistryFactory.deploy(
    owner.address,
    hre.ethers.parseEther('0.0001') // MIN_BOND
  )) as unknown as QuoteRegistry
  await registry.waitForDeployment()
  const registryAddress = await registry.getAddress()

  // Deploy SLAEscrow via UUPS proxy (no Timelock -- owner stays as deployer for playground)
  const EscrowFactory = await hre.ethers.getContractFactory('SLAEscrow')
  const escrow = (await hre.upgrades.deployProxy(
    EscrowFactory,
    [
      registryAddress,
      owner.address, // feeRecipient
    ],
    { kind: 'uups', constructorArgs: [entryPointAddress] }
  )) as unknown as SLAEscrow
  await escrow.waitForDeployment()
  const escrowAddress = await escrow.getAddress()

  return {
    registry,
    escrow,
    registryAddress,
    escrowAddress,
    entryPoint,
    owner,
  }
}

/**
 * Same as setup(), but also deploys a TimelockController and transfers
 * SLAEscrow ownership to it -- mirroring the production deployment.
 *
 * @param delaySeconds  Timelock minimum delay in seconds.
 *                      Use a small value (e.g. 5) for interactive play;
 *                      production uses 172800 (48h).
 *
 * To execute a timelocked call you need to:
 *   1. schedule(target, value, data, predecessor, salt, delay)  -- queues the call
 *   2. evm_increaseTime(delaySeconds) + evm_mine              -- advance time past the delay
 *   3. execute(target, value, data, predecessor, salt)         -- executes the call
 *
 * The owner signer is the initial proposer and admin on the Timelock.
 * Anyone (ZeroAddress executor) can call execute() after the delay.
 */
export async function setupWithTimelock(delaySeconds: number): Promise<TimelockContext> {
  const base = await setup()
  const { owner, escrow, registry } = base

  const TimelockFactory = await hre.ethers.getContractFactory('TimelockController')
  const timelock = (await TimelockFactory.deploy(
    delaySeconds,
    [owner.address],          // proposers -- owner queues calls
    [hre.ethers.ZeroAddress], // executors -- anyone can execute after delay
    owner.address,            // admin -- can add multisig as proposer, then renounce
  )) as unknown as TimelockController
  await timelock.waitForDeployment()
  const timelockAddress = await timelock.getAddress()

  // Transfer both contract ownerships to the Timelock (mirrors production)
  await (await (escrow as any).connect(owner).transferOwnership(timelockAddress)).wait()
  await (await (registry as any).connect(owner).transferOwnership(timelockAddress)).wait()

  return {
    ...base,
    timelock,
    timelockAddress,
    timelockDelay: delaySeconds,
  }
}
