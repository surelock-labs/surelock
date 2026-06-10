// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Test} from "forge-std/Test.sol";
import {OfferRegistry} from "src/OfferRegistry.sol";
import {SLAEscrow} from "src/SLAEscrow.sol";
import {WatcherRegistry} from "src/WatcherRegistry.sol";

contract NonPayableAccount {
    function deposit(SLAEscrow escrow) external payable {
        escrow.deposit{value: msg.value}();
    }

    function withdraw(SLAEscrow escrow, uint256 amount) external {
        escrow.withdraw(amount);
    }

    function withdrawTo(SLAEscrow escrow, address payable to, uint256 amount) external {
        escrow.withdrawTo(to, amount);
    }
}

contract SLAEscrowWithdrawToTest is Test {
    uint256 constant AMOUNT = 1 ether;

    SLAEscrow escrow;
    NonPayableAccount account;

    address owner = address(this);
    address watcher = address(0xA11CE);
    address payable beneficiary = payable(address(0xBEEF));

    function setUp() public {
        OfferRegistry registry = new OfferRegistry();
        WatcherRegistry watcherRegistry = new WatcherRegistry(owner, watcher, watcher);
        escrow = new SLAEscrow(address(registry), address(watcherRegistry), owner);
        account = new NonPayableAccount();

        vm.deal(address(this), 2 * AMOUNT);
    }

    function testWithdrawRevertsWhenAccountCannotReceiveEth() public {
        account.deposit{value: AMOUNT}(escrow);

        vm.expectRevert();
        account.withdraw(escrow, AMOUNT);

        assertEq(escrow.balanceOf(address(account)), AMOUNT);
        assertEq(address(escrow).balance, AMOUNT);
        assertEq(address(account).balance, 0);
    }

    function testWithdrawToRedirectsContractAccountBalance() public {
        account.deposit{value: AMOUNT}(escrow);

        account.withdrawTo(escrow, beneficiary, AMOUNT);

        assertEq(escrow.balanceOf(address(account)), 0);
        assertEq(address(escrow).balance, 0);
        assertEq(address(account).balance, 0);
        assertEq(beneficiary.balance, AMOUNT);
    }

    function testWithdrawRejectsZeroAmount() public {
        vm.expectRevert(SLAEscrow.ZeroAmount.selector);
        escrow.withdraw(0);
    }

    function testWithdrawToRejectsZeroAmount() public {
        vm.expectRevert(SLAEscrow.ZeroAmount.selector);
        escrow.withdrawTo(beneficiary, 0);
    }
}
