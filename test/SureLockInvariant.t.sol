// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Test} from "forge-std/Test.sol";
import {ISureLock} from "src/ISureLock.sol";
import {SureLock} from "src/SureLock.sol";
import {WatcherRegistry} from "src/WatcherRegistry.sol";

contract SureLockInvariantHandler is Test {
    uint256 constant MAX_OFFERS = 8;
    uint256 constant MAX_COMMITS = 32;
    uint256 constant INITIAL_ETH = 100 ether;

    SureLock public surelock;
    WatcherRegistry public registry;

    address public watcher;
    address[] internal providers;
    address[] internal clients;
    address[] internal balanceAccounts;
    uint256[] internal offerIds;
    uint256[] internal commitIds;

    mapping(uint256 commitId => bool recorded) public terminalRecorded;
    mapping(uint256 commitId => SureLock.CommitStatus status) public terminalStatus;

    constructor(SureLock surelock_, WatcherRegistry registry_, address watcher_, address feeRecipient_) {
        surelock = surelock_;
        registry = registry_;
        watcher = watcher_;

        providers.push(address(0x1001));
        providers.push(address(0x1002));
        providers.push(address(0x1003));

        clients.push(address(0x2001));
        clients.push(address(0x2002));
        clients.push(address(0x2003));

        for (uint256 i = 0; i < providers.length; i++) {
            balanceAccounts.push(providers[i]);
        }
        for (uint256 i = 0; i < clients.length; i++) {
            balanceAccounts.push(clients[i]);
        }
        balanceAccounts.push(feeRecipient_);
    }

    function seed() external {
        for (uint256 i = 0; i < balanceAccounts.length; i++) {
            vm.deal(balanceAccounts[i], INITIAL_ETH);
        }
        for (uint256 i = 0; i < providers.length; i++) {
            _deposit(providers[i], 10 ether);
            _register(providers[i], 0.01 ether, 20, 0.03 ether, surelock.MIN_LIFETIME());
        }
    }

    function deposit(uint256 providerSeed, uint256 amountSeed) external {
        address provider = _provider(providerSeed);
        uint256 amount = bound(amountSeed, 1 wei, 1 ether);

        _dealMore(provider, amount);
        _deposit(provider, amount);
    }

    function withdraw(uint256 accountSeed, uint256 amountSeed) external {
        address account = _balanceAccount(accountSeed);
        uint256 idle = surelock.balanceOf(account) - surelock.lockedOf(account);
        if (idle == 0) return;

        uint256 amount = bound(amountSeed, 1 wei, idle);

        vm.prank(account);
        try surelock.withdraw(amount) {} catch {}
    }

    function registerOffer(uint256 providerSeed, uint256 feeSeed, uint256 slaSeed, uint256 collateralSeed) external {
        if (offerIds.length >= MAX_OFFERS) return;

        uint256 feePerOp = bound(feeSeed, 1 gwei, 0.05 ether);
        uint256 slaBlocks = bound(slaSeed, surelock.MIN_SLA_BLOCKS(), surelock.MAX_SLA_BLOCKS());
        uint256 collateral = feePerOp + bound(collateralSeed, 1 wei, 0.2 ether);

        _register(_provider(providerSeed), feePerOp, slaBlocks, collateral, surelock.MIN_LIFETIME());
    }

    function renewOffer(uint256 offerSeed, uint256 lifetimeSeed) external {
        if (offerIds.length == 0) return;

        uint256 offerId = _offerId(offerSeed);
        SureLock.Offer memory offer;
        try surelock.getOffer(offerId) returns (SureLock.Offer memory loaded) {
            offer = loaded;
        } catch {
            return;
        }

        uint256 lifetime = bound(lifetimeSeed, surelock.MIN_LIFETIME(), surelock.MAX_LIFETIME());

        vm.prank(offer.provider);
        try surelock.renew(offerId, lifetime) {} catch {}
    }

    function deactivateOffer(uint256 offerSeed) external {
        if (offerIds.length == 0) return;

        uint256 offerId = _offerId(offerSeed);
        SureLock.Offer memory offer;
        try surelock.getOffer(offerId) returns (SureLock.Offer memory loaded) {
            offer = loaded;
        } catch {
            return;
        }

        vm.prank(offer.provider);
        try surelock.deactivate(offerId) {} catch {}
    }

    function commit(uint256 clientSeed, uint256 offerSeed, uint256 hashSeed, uint256 acceptWindowSeed) external {
        if (offerIds.length == 0 || commitIds.length >= MAX_COMMITS) return;

        uint256 offerId = _offerId(offerSeed);
        if (!surelock.isActive(offerId)) return;

        SureLock.Offer memory offer;
        try surelock.getOffer(offerId) returns (SureLock.Offer memory loaded) {
            offer = loaded;
        } catch {
            return;
        }

        address client = _client(clientSeed);
        if (client == offer.provider) return;

        bytes32 userOpHash = bytes32(bound(hashSeed, 1, 12));
        if (surelock.userOpHashStatus(userOpHash) != SureLock.UserOpHashStatus.None) return;

        uint256 acceptWindow = bound(acceptWindowSeed, 1, surelock.MAX_ACCEPT_WINDOW_BLOCKS());
        uint256 value = offer.feePerOp + surelock.protocolFee();

        _dealMore(client, value);
        vm.prank(client);
        try surelock.commit{value: value}(offerId, userOpHash, acceptWindow) returns (uint256 commitId) {
            commitIds.push(commitId);
        } catch {}
    }

    function accept(uint256 commitSeed) external {
        uint256 commitId = _commitIdOrZero(commitSeed);
        if (commitId == 0) return;

        SureLock.Commit memory c = surelock.getCommit(commitId);
        if (c.status != SureLock.CommitStatus.Proposed) return;

        vm.prank(c.provider);
        try surelock.accept(commitId) {} catch {}
    }

    function cancel(uint256 commitSeed, uint256 callerSeed) external {
        uint256 commitId = _commitIdOrZero(commitSeed);
        if (commitId == 0) return;

        SureLock.Commit memory c = surelock.getCommit(commitId);
        if (c.status != SureLock.CommitStatus.Proposed) return;

        bool acceptWindowOpen = block.number <= c.acceptDeadline;
        if (acceptWindowOpen) {
            vm.prank(c.user);
            try surelock.cancel(commitId) {
                _recordTerminal(commitId);
            } catch {}
            return;
        }

        uint256 caller = bound(callerSeed, 0, 2);
        if (caller == 0) {
            vm.prank(c.user);
            try surelock.cancel(commitId) {
                _recordTerminal(commitId);
            } catch {}
        } else if (caller == 1) {
            vm.prank(c.provider);
            try surelock.cancel(commitId) {
                _recordTerminal(commitId);
            } catch {}
        } else {
            vm.prank(watcher);
            try registry.cancel(ISureLock(address(surelock)), commitId) {
                _recordTerminal(commitId);
            } catch {}
        }
    }

    function settle(uint256 commitSeed, uint256 inclusionSeed) external {
        uint256 commitId = _commitIdOrZero(commitSeed);
        if (commitId == 0) return;

        SureLock.Commit memory c = surelock.getCommit(commitId);
        if (c.status != SureLock.CommitStatus.Active) return;

        uint256 inclusionBlock = c.acceptedBlock + bound(inclusionSeed, 1, c.slaBlocks);
        if (block.number < inclusionBlock) vm.roll(inclusionBlock);

        vm.prank(watcher);
        try registry.settle(ISureLock(address(surelock)), commitId, inclusionBlock) {
            _recordTerminal(commitId);
        } catch {}
    }

    function refund(uint256 commitSeed) external {
        uint256 commitId = _commitIdOrZero(commitSeed);
        if (commitId == 0) return;

        SureLock.Commit memory c = surelock.getCommit(commitId);
        if (c.status != SureLock.CommitStatus.Active) return;
        if (block.number <= c.deadline) vm.roll(c.deadline + 1);


        vm.prank(watcher);
        try registry.refund(ISureLock(address(surelock)), commitId) {
            _recordTerminal(commitId);
        } catch {}
    }

    function rollBlocks(uint256 blocksSeed) external {
        vm.roll(block.number + bound(blocksSeed, 0, 50));
    }

    function balanceAccountCount() external view returns (uint256) {
        return balanceAccounts.length;
    }

    function balanceAccountAt(uint256 index) external view returns (address) {
        return balanceAccounts[index];
    }

    function commitCount() external view returns (uint256) {
        return commitIds.length;
    }

    function commitIdAt(uint256 index) external view returns (uint256) {
        return commitIds[index];
    }

    function _register(address provider, uint256 feePerOp, uint256 slaBlocks, uint256 collateral, uint256 lifetime)
        internal
    {
        vm.prank(provider);
        try surelock.register(feePerOp, slaBlocks, collateral, lifetime) returns (uint256 offerId) {
            offerIds.push(offerId);
        } catch {}
    }

    function _deposit(address provider, uint256 amount) internal {
        vm.prank(provider);
        try surelock.deposit{value: amount}() {} catch {}
    }

    function _recordTerminal(uint256 commitId) internal {
        if (terminalRecorded[commitId]) return;

        SureLock.CommitStatus status = surelock.getCommit(commitId).status;
        if (!_isResolved(status)) return;

        terminalRecorded[commitId] = true;
        terminalStatus[commitId] = status;
    }

    function _dealMore(address account, uint256 amount) internal {
        vm.deal(account, account.balance + amount);
    }

    function _provider(uint256 selectorSeed) internal view returns (address) {
        return providers[bound(selectorSeed, 0, providers.length - 1)];
    }

    function _client(uint256 selectorSeed) internal view returns (address) {
        return clients[bound(selectorSeed, 0, clients.length - 1)];
    }

    function _balanceAccount(uint256 selectorSeed) internal view returns (address) {
        return balanceAccounts[bound(selectorSeed, 0, balanceAccounts.length - 1)];
    }

    function _offerId(uint256 selectorSeed) internal view returns (uint256) {
        return offerIds[bound(selectorSeed, 0, offerIds.length - 1)];
    }

    function _commitIdOrZero(uint256 selectorSeed) internal view returns (uint256) {
        if (commitIds.length == 0) return 0;
        return commitIds[bound(selectorSeed, 0, commitIds.length - 1)];
    }

    function _isResolved(SureLock.CommitStatus status) internal pure returns (bool) {
        return status == SureLock.CommitStatus.Settled || status == SureLock.CommitStatus.Refunded
            || status == SureLock.CommitStatus.Cancelled;
    }
}

contract SureLockInvariantTest is Test {
    SureLock surelock;
    WatcherRegistry registry;
    SureLockInvariantHandler handler;

    address owner = address(this);
    address watcher = address(0xA11CE);
    address feeRecipient = address(0xFEE);

    function setUp() public {
        registry = new WatcherRegistry(owner, feeRecipient, watcher);
        surelock = new SureLock(address(registry), owner);
        surelock.setProtocolFee(1 gwei);

        handler = new SureLockInvariantHandler(surelock, registry, watcher, feeRecipient);
        handler.seed();

        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = handler.deposit.selector;
        selectors[1] = handler.withdraw.selector;
        selectors[2] = handler.registerOffer.selector;
        selectors[3] = handler.renewOffer.selector;
        selectors[4] = handler.deactivateOffer.selector;
        selectors[5] = handler.commit.selector;
        selectors[6] = handler.accept.selector;
        selectors[7] = handler.cancel.selector;
        selectors[8] = handler.settle.selector;
        selectors[9] = handler.refund.selector;
        selectors[10] = handler.rollBlocks.selector;

        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_lockedNeverExceedsBalance() public view {
        uint256 count = handler.balanceAccountCount();
        for (uint256 i = 0; i < count; i++) {
            address account = handler.balanceAccountAt(i);
            assertLe(surelock.lockedOf(account), surelock.balanceOf(account), "locked exceeds balance");
        }
    }

    function invariant_lockedBalanceMatchesActiveCollateral() public view {
        uint256 accountCount = handler.balanceAccountCount();
        for (uint256 i = 0; i < accountCount; i++) {
            address account = handler.balanceAccountAt(i);
            uint256 activeCollateral;
            uint256 commitCount = handler.commitCount();

            for (uint256 j = 0; j < commitCount; j++) {
                SureLock.Commit memory c = surelock.getCommit(handler.commitIdAt(j));
                if (c.status == SureLock.CommitStatus.Active && c.provider == account) {
                    activeCollateral += c.collateral;
                }
            }

            assertEq(surelock.lockedOf(account), activeCollateral, "locked collateral mismatch");
        }
    }

    function invariant_contractBalanceMatchesInternalBalances() public view {
        uint256 internalBalances;
        uint256 count = handler.balanceAccountCount();

        for (uint256 i = 0; i < count; i++) {
            internalBalances += surelock.balanceOf(handler.balanceAccountAt(i));
        }

        uint256 liveCommitFees;
        count = handler.commitCount();

        for (uint256 i = 0; i < count; i++) {
            SureLock.Commit memory c = surelock.getCommit(handler.commitIdAt(i));
            if (_isLive(c.status)) liveCommitFees += c.feePaid;
        }

        assertEq(address(surelock).balance, internalBalances + liveCommitFees, "contract balance mismatch");
    }

    function invariant_terminalCommitsStayTerminal() public view {
        uint256 count = handler.commitCount();
        for (uint256 i = 0; i < count; i++) {
            uint256 commitId = handler.commitIdAt(i);
            if (!handler.terminalRecorded(commitId)) continue;

            SureLock.CommitStatus expected = handler.terminalStatus(commitId);
            SureLock.CommitStatus actual = surelock.getCommit(commitId).status;

            assertEq(uint256(actual), uint256(expected), "terminal status changed");
        }
    }

    function invariant_userOpHashStatusMatchesLifecycle() public view {
        uint256 count = handler.commitCount();
        for (uint256 i = 0; i < count; i++) {
            bytes32 userOpHash = surelock.getCommit(handler.commitIdAt(i)).userOpHash;
            SureLock.UserOpHashStatus expected = _expectedHashStatus(userOpHash);
            SureLock.UserOpHashStatus actual = surelock.userOpHashStatus(userOpHash);

            assertEq(uint256(actual), uint256(expected), "hash status mismatch");
        }
    }

    function invariant_liveUserOpHashesAreUnique() public view {
        uint256 count = handler.commitCount();
        for (uint256 i = 0; i < count; i++) {
            SureLock.Commit memory left = surelock.getCommit(handler.commitIdAt(i));
            if (!_isLive(left.status)) continue;

            for (uint256 j = i + 1; j < count; j++) {
                SureLock.Commit memory right = surelock.getCommit(handler.commitIdAt(j));
                if (!_isLive(right.status)) continue;

                assertTrue(left.userOpHash != right.userOpHash, "duplicate live userOpHash");
            }
        }
    }

    function invariant_commitShapeMatchesStatus() public view {
        uint256 count = handler.commitCount();
        for (uint256 i = 0; i < count; i++) {
            SureLock.Commit memory c = surelock.getCommit(handler.commitIdAt(i));

            if (c.status == SureLock.CommitStatus.Proposed || c.status == SureLock.CommitStatus.Cancelled) {
                assertEq(c.acceptedBlock, 0, "inactive commit accepted block");
                assertEq(c.deadline, 0, "inactive commit deadline");
            } else {
                assertGt(c.acceptedBlock, 0, "accepted block missing");
                assertEq(c.deadline, c.acceptedBlock + c.slaBlocks, "bad deadline");
            }
        }
    }

    function _expectedHashStatus(bytes32 userOpHash) internal view returns (SureLock.UserOpHashStatus) {
        bool live;
        bool consumed;
        uint256 count = handler.commitCount();

        for (uint256 i = 0; i < count; i++) {
            SureLock.Commit memory c = surelock.getCommit(handler.commitIdAt(i));
            if (c.userOpHash != userOpHash) continue;

            if (_isLive(c.status)) live = true;
            if (c.status == SureLock.CommitStatus.Settled || c.status == SureLock.CommitStatus.Refunded) {
                consumed = true;
            }
        }

        if (live) return SureLock.UserOpHashStatus.Active;
        if (consumed) return SureLock.UserOpHashStatus.Consumed;
        return SureLock.UserOpHashStatus.None;
    }

    function _isLive(SureLock.CommitStatus status) internal pure returns (bool) {
        return status == SureLock.CommitStatus.Proposed || status == SureLock.CommitStatus.Active;
    }
}
