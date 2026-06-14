// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Test} from "forge-std/Test.sol";
import {SureLock} from "src/SureLock.sol";
import {WatcherRegistry} from "src/WatcherRegistry.sol";

contract NonPayableAccount {
    function deposit(SureLock surelock) external payable {
        surelock.deposit{value: msg.value}();
    }

    function withdraw(SureLock surelock, uint256 amount) external {
        surelock.withdraw(amount);
    }

    function withdrawTo(SureLock surelock, address payable to, uint256 amount) external {
        surelock.withdrawTo(to, amount);
    }
}

contract SureLockWithdrawToTest is Test {
    uint256 constant AMOUNT = 1 ether;

    SureLock surelock;
    NonPayableAccount account;

    address owner = address(this);
    address watcher = address(0xA11CE);
    address payable beneficiary = payable(address(0xBEEF));

    function setUp() public {
        WatcherRegistry watcherRegistry = new WatcherRegistry(owner, watcher, watcher);
        surelock = new SureLock(address(watcherRegistry), owner);
        account = new NonPayableAccount();

        vm.deal(address(this), 2 * AMOUNT);
    }

    function testWithdrawRevertsWhenAccountCannotReceiveEth() public {
        account.deposit{value: AMOUNT}(surelock);

        vm.expectRevert();
        account.withdraw(surelock, AMOUNT);

        assertEq(surelock.balanceOf(address(account)), AMOUNT);
        assertEq(address(surelock).balance, AMOUNT);
        assertEq(address(account).balance, 0);
    }

    function testWithdrawToRedirectsContractAccountBalance() public {
        account.deposit{value: AMOUNT}(surelock);

        account.withdrawTo(surelock, beneficiary, AMOUNT);

        assertEq(surelock.balanceOf(address(account)), 0);
        assertEq(address(surelock).balance, 0);
        assertEq(address(account).balance, 0);
        assertEq(beneficiary.balance, AMOUNT);
    }

    function testWithdrawRejectsZeroAmount() public {
        vm.expectRevert(SureLock.ZeroAmount.selector);
        surelock.withdraw(0);
    }

    function testWithdrawToRejectsZeroAmount() public {
        vm.expectRevert(SureLock.ZeroAmount.selector);
        surelock.withdrawTo(beneficiary, 0);
    }
}
