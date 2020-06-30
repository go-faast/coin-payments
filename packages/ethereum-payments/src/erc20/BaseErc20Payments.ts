import InputDataDecoder from 'ethereum-input-data-decoder';
import { BigNumber } from 'bignumber.js'
import { TransactionReceipt } from 'web3-core'
import {
  BalanceResult,
  TransactionStatus,
  FeeLevel,
  FeeOption,
  FeeRateType,
  FeeOptionCustom,
  ResolveablePayport,
  CreateTransactionOptions as TransactionOptions,
  FromTo,
} from '@faast/payments-common'
import {
  isType,
  isNumber,
  Numeric,
} from '@faast/ts-common'

import {
  BaseErc20PaymentsConfig,
  EthereumUnsignedTransaction,
  EthereumResolvedFeeOption,
  EthereumTransactionOptions,
  EthereumTransactionInfo,
} from '../types'
import {
  DEFAULT_FEE_LEVEL,
  FEE_LEVEL_MAP,
  MIN_CONFIRMATIONS,
  TOKEN_WALLET_DATA,
  TOKEN_WALLET_ABI,
  TOKEN_TRANSFER_COST,
  TOKEN_METHODS_ABI,
  DEPOSIT_KEY_INDEX,
  DECIMAL_PLACES,
} from '../constants'
import { BaseEthereumPayments } from '../BaseEthereumPayments'
import { EthereumPaymentsUtils } from '../EthereumPaymentsUtils'

export abstract class BaseErc20Payments <Config extends BaseErc20PaymentsConfig> extends BaseEthereumPayments<Config> {
  public tokenAddress: string
  public depositKeyIndex: number

  constructor(config: Config) {
    super(config)
    this.tokenAddress = config.tokenAddress

    this.depositKeyIndex = (typeof config.depositKeyIndex === 'undefined') ? DEPOSIT_KEY_INDEX : config.depositKeyIndex
  }

  async getBalance(resolveablePayport: ResolveablePayport): Promise<BalanceResult> {
    const payport = await this.resolvePayport(resolveablePayport)
    const contract = new this.eth.Contract(TOKEN_METHODS_ABI, this.tokenAddress)
    const balance = await contract.methods.balanceOf(payport.address).call({})

    const sweepable = await this.isSweepableBalance(this.toMainDenomination(balance))

    return {
      confirmedBalance: this.toMainDenomination(balance),
      unconfirmedBalance: '0',
      spendableBalance: this.toMainDenomination(balance),
      sweepable,
      requiresActivation: false,
    }
  }

  async isSweepableBalance(balance: string): Promise<boolean> {
    const feeOption = await this.resolveFeeOption({})
    const payport = await this.resolvePayport(this.depositKeyIndex)

    const feeWei = new BigNumber(feeOption.feeBase)
    const balanceWei = await this.eth.getBalance(payport.address)

    if (balanceWei === '0' || balance === '0') {
      return false
    }

    return ((new BigNumber(balanceWei)).isGreaterThanOrEqualTo(feeWei))
  }

  async createTransaction(
    from: number | string,
    to: ResolveablePayport,
    amountMain: string,
    options: EthereumTransactionOptions = {},
  ): Promise<EthereumUnsignedTransaction> {
    this.logger.debug('createTransaction', from, to, amountMain)

    const fromTo = await this.resolveFromTo(from as number, to)
    const txFromAddress = fromTo.fromAddress

    const amountOfGas = await this.gasStation.estimateGas(fromTo.fromAddress, fromTo.toAddress, 'TOKEN_TRANSFER')
    const feeOption: EthereumResolvedFeeOption = isType(FeeOptionCustom, options)
      ? this.resolveCustomFeeOption(options, amountOfGas)
      : await this.resolveLeveledFeeOption(options, amountOfGas)
    const feeBase = new BigNumber(feeOption.feeBase)

    const nonce = options.sequenceNumber || await this.getNextSequenceNumber(txFromAddress)

    let amountBase = this.toBaseDenominationBigNumber(amountMain)
    let ethBalance = await this.getEthBaseBalance(fromTo.fromAddress)

    if (feeBase.isGreaterThan(ethBalance)) {
      throw new Error(`Insufficient ETH balance (${this.toMainDenominationEth(ethBalance)}) to pay transaction fee of ${feeOption.feeMain}`)
    }

    const contract = new this.eth.Contract(TOKEN_METHODS_ABI, this.tokenAddress)
    const transactionObject = {
      from:     fromTo.fromAddress,
      to:       this.tokenAddress,
      value:    '0x0',
      gas:      `0x${(new BigNumber(amountOfGas)).toString(16)}`,
      gasPrice: `0x${(new BigNumber(feeOption.gasPrice)).toString(16)}`,
      nonce:    `0x${(new BigNumber(nonce)).toString(16)}`,
      data: contract.methods.transfer(fromTo.toAddress, `0x${amountBase.toString(16)}`).encodeABI()
    }

    return {
      status: TransactionStatus.Unsigned,
      id: '',
      fromAddress: fromTo.fromAddress,
      toAddress: fromTo.toAddress,
      toExtraId: null,
      fromIndex: fromTo.fromIndex,
      toIndex: fromTo.toIndex,
      amount: amountMain,
      fee: feeOption.feeMain,
      targetFeeLevel: feeOption.targetFeeLevel,
      targetFeeRate: feeOption.targetFeeRate,
      targetFeeRateType: feeOption.targetFeeRateType,
      sequenceNumber: nonce.toString(),
      data: transactionObject,
    }
  }

  async createSweepTransaction(
    from: string | number,
    to: ResolveablePayport,
    options: EthereumTransactionOptions = {},
  ): Promise<EthereumUnsignedTransaction> {
    this.logger.debug('createSweepTransaction', from, to)

    // NOTE sweep from hot wallet which is not guaranteed to support sweep contract execution
    if (isNumber(from)) {
      const { confirmedBalance } = await this.getBalance(from)
      return this.createTransaction(from, to, confirmedBalance, options)
    }

    const toPayport = await this.resolvePayport(to)
    const ownerPayport = await this.resolvePayport(this.depositKeyIndex)
    const ownerAddress = ownerPayport.address
    const fromTo = {
      fromAddress: `${from}`,
      fromIndex: this.depositKeyIndex,
      fromExtraId: null,
      fromPayport: { address: `${from}` },

      toAddress: toPayport.address,
      toIndex: typeof to === 'number' ? to : null,
      toExtraId: toPayport.extraId,
      toPayport,
    }

    const amountOfGas = await this.gasStation.estimateGas(fromTo.fromAddress, fromTo.toAddress, 'TOKEN_SWEEP')
    const feeOption: EthereumResolvedFeeOption = isType(FeeOptionCustom, options)
      ? this.resolveCustomFeeOption(options, amountOfGas)
      : await this.resolveLeveledFeeOption(options, amountOfGas)

    const feeBase = new BigNumber(feeOption.feeBase)

    let ethBalance = await this.getEthBaseBalance(ownerAddress)
    const { confirmedBalance: tokenBalanceMain } = await this.getBalance(fromTo.fromPayport)
    const tokenBalanceBase = this.toBaseDenominationBigNumber(tokenBalanceMain)
    if (feeBase.isGreaterThan(ethBalance)) {
      throw new Error(
        `Insufficient ETH balance (${this.toMainDenominationEth(ethBalance)}) at owner address ${ownerAddress} `
        + `to sweep contract ${fromTo.fromAddress} with fee of ${feeOption.feeMain} ETH`)
    }

    if (tokenBalanceBase.isLessThan(0)) {
      throw new Error(`Insufficient token balance (${tokenBalanceMain}) to sweep`)
    }

    const nonce = options.sequenceNumber || await this.getNextSequenceNumber(ownerAddress)
    const contract = new this.eth.Contract(TOKEN_WALLET_ABI, fromTo.fromAddress)
    const transactionObject = {
      nonce:    `0x${(new BigNumber(nonce)).toString(16)}`,
      to:       fromTo.fromAddress,
      gasPrice: `0x${(new BigNumber(feeOption.gasPrice)).toString(16)}`,
      gas:      `0x${(new BigNumber(amountOfGas)).toString(16)}`,
      data: contract.methods.sweep(this.tokenAddress, fromTo.toAddress).encodeABI()
    }

    return {
      status: TransactionStatus.Unsigned,
      id: '',
      fromAddress: fromTo.fromAddress,
      toAddress: fromTo.toAddress,
      toExtraId: null,
      fromIndex: this.depositKeyIndex,
      toIndex: fromTo.toIndex,
      amount: tokenBalanceMain,
      fee: feeOption.feeMain,
      targetFeeLevel: feeOption.targetFeeLevel,
      targetFeeRate: feeOption.targetFeeRate,
      targetFeeRateType: feeOption.targetFeeRateType,
      sequenceNumber: nonce.toString(),
      data: transactionObject,
    }
  }

  async getTransactionInfo(txid: string): Promise<EthereumTransactionInfo> {
    const minConfirmations = MIN_CONFIRMATIONS
    const tx = await this.eth.getTransaction(txid)

    if (!tx.input) {
      throw new Error(`Transaction ${txid} has no input for ERC20`)
    }

    let toAddress = ''
    let amount = ''

    // ERC20 signature
    if (tx.input.startsWith('0xa9059cbb')) {
      if((tx.to || '').toLowerCase() !== this.tokenAddress.toLowerCase()) {
        throw new Error(`Transaction ${txid} was sent to different contract: ${tx.to}, Expected: ${this.tokenAddress}`)
      }

      const tokenDecoder = new InputDataDecoder(TOKEN_METHODS_ABI);
      const txData = tokenDecoder.decodeData(tx.input)
      toAddress = `0x${txData.inputs[0]}`
      amount = this.toMainDenomination(txData.inputs[1].toString())
    } else if (tx.input.startsWith('0x60606040')) {
      // SWEEP contract creation
    } else if (tx.input.startsWith('0xb8dc491b')) {
      // SWEEPING
    } else {
      throw new Error(`Transaction ${txid} is not ERC20 transaction neither swap`)
    }

    const currentBlockNumber = await this.eth.getBlockNumber()
    let txInfo: TransactionReceipt | null = await this.eth.getTransactionReceipt(txid)

    // NOTE: for the sake of consistent schema return
    if (!txInfo) {
      txInfo = {
        transactionHash: tx.hash,
        from: tx.from || '',
        to: toAddress,
        status: true,
        blockNumber: 0,
        cumulativeGasUsed: 0,
        gasUsed: 0,
        transactionIndex: 0,
        blockHash: '',
        logs: [],
        logsBloom: ''
      }

      return {
        id: txid,
        amount,
        toAddress,
        fromAddress: tx.from,
        toExtraId: null,
        fromIndex: null,
        toIndex: null,
        fee: this.toMainDenominationEth((new BigNumber(tx.gasPrice)).multipliedBy(tx.gas)),
        sequenceNumber: tx.nonce,
        isExecuted: false,
        isConfirmed: false,
        confirmations: 0,
        confirmationId: null,
        confirmationTimestamp: null,
        currentBlockNumber: currentBlockNumber,
        status: TransactionStatus.Pending,
        data: {
          ...tx,
          ...txInfo,
          currentBlock: currentBlockNumber
        },
      }
    }

    let txBlock: any = null
    let isConfirmed = false
    let confirmationTimestamp: Date | null = null
    let confirmations = 0
    if (tx.blockNumber) {
      confirmations = currentBlockNumber - tx.blockNumber
      if (confirmations > minConfirmations) {
        isConfirmed = true
        txBlock = await this.eth.getBlock(tx.blockNumber)
        confirmationTimestamp = new Date(txBlock.timestamp)
      }
    }

    let status: TransactionStatus = TransactionStatus.Pending
    if (isConfirmed) {
      status = TransactionStatus.Confirmed
      // No trust to types description of web3
      if (txInfo.hasOwnProperty('status') && (txInfo.status === false || txInfo.status.toString() === 'false')) {
        status = TransactionStatus.Failed
      }
    }

    return {
      id: txid,
      amount,
      toAddress,
      fromAddress: tx.from,
      toExtraId: null,
      fromIndex: null,
      toIndex: null,
      fee: this.toMainDenominationEth((new BigNumber(tx.gasPrice)).multipliedBy(txInfo.gasUsed)),
      sequenceNumber: tx.nonce,
      // XXX if tx was confirmed but not accepted by network isExecuted must be false
      isExecuted: status !== TransactionStatus.Failed,
      isConfirmed,
      confirmations,
      confirmationId: tx.blockHash,
      confirmationTimestamp,
      status,
      currentBlockNumber: currentBlockNumber,
      data: {
        ...tx,
        ...txInfo,
        currentBlock: currentBlockNumber
      },
    }
  }

  async getNextSequenceNumber(payport: ResolveablePayport): Promise<string> {
    const resolvedPayport = await this.resolvePayport(payport)
    const sequenceNumber = await this.gasStation.getNonce(resolvedPayport.address)

    return sequenceNumber
  }

  private async getEthBaseBalance(address: string): Promise<BigNumber> {
    const balanceBase = await this.eth.getBalance(address)

    return new BigNumber(balanceBase)
  }
}

export default BaseErc20Payments
