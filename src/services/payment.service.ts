// src/services/payment.service.ts
import PayOS from "@payos/node";
import { Payment } from "../models/payment.model";
import User, { IUser } from "../models/User";
import { ServiceResponse, PaymentData } from "../types/payment.type";
import mongoose from "mongoose";
import dotenv from 'dotenv';
dotenv.config();

export class PaymentService {
  private static payOS = new PayOS(
    process.env.PAYOS_CLIENT_ID!,
    process.env.PAYOS_API_KEY!,
    process.env.PAYOS_CHECKSUM_KEY!
  );

  private static readonly PREMIUM_PRICE = 10000;

  static async createUpgradePayment(userId: string): Promise<ServiceResponse<PaymentData>> {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error("User not found");
      }

      if (user.role === "member_premium") {
        throw new Error("User already has premium membership");
      }

      // Sử dụng số cho orderCode
      const orderCode = Number(Date.now().toString().slice(-10));

      const description = 'Premium';

      console.log("Description length:", description.length); // Kiểm tra độ dài
      console.log("OrderCode:", orderCode);

      const paymentData = {
        orderCode,
        amount: this.PREMIUM_PRICE,
        description,
        cancelUrl: `${process.env.BE_URL}/payment/cancel`,
        returnUrl: `${process.env.BE_URL}/payment/success`,
        webhookUrl: process.env.PAYOS_WEBHOOK_URL
      };
      console.log("Payment data:", paymentData);

      const paymentResponse = await this.payOS.createPaymentLink(paymentData);

      // Lưu thông tin payment, bao gồm userId
      await Payment.create({
        orderId: orderCode.toString(),
        userId,
        amount: this.PREMIUM_PRICE,
        type: 'UPGRADE_PREMIUM',
        status: 'PENDING',
        paymentLinkId: paymentResponse.paymentLinkId,
        paymentData: JSON.stringify(paymentResponse)
      });

      // Trả về URL thanh toán cho FE
      return {
        success: true,
        data: {
          checkoutUrl: paymentResponse.checkoutUrl,
          orderCode: orderCode.toString()
        }
      };

    } catch (error: any) {
      console.error("Create payment error:", error);
      return {
        success: false,
        message: error.message
      };
    }
  }


  static async handleWebhook(webhookData: any) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Verify webhook data
      const isValidSignature = this.payOS.verifyPaymentWebhookData(webhookData);

      if (!isValidSignature) {
        throw new Error("Invalid webhook signature");
      }

      if (webhookData.code === "00") { // Success
        try {
          // Update payment status
          const payment = await Payment.findOneAndUpdate(
            { orderId: webhookData.data.orderCode.toString() },
            {
              status: "SUCCESS",
              paymentData: JSON.stringify(webhookData.data)
            },
            { session }
          );

          if (!payment) {
            throw new Error("Payment not found");
          }

          // Update user role using userId from payment
          const user = await User.findByIdAndUpdate(
            payment.userId,
            {
              role: "member_premium",
              premiumStartDate: new Date(),
              premiumEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days from now
            },
            { session, new: true }
          );

          if (!user) {
            throw new Error("User not found");
          }

          await session.commitTransaction();
          return { success: true, message: "Payment processed successfully" };
        } catch (error) {
          await session.abortTransaction();
          throw error;
        }
      } else if (webhookData.code === "01") { // Cancel
        await Payment.findOneAndUpdate(
          { orderId: webhookData.data.orderCode.toString() },
          {
            status: "CANCELLED",
            paymentData: JSON.stringify(webhookData.data)
          },
          { session }
        );

        await session.commitTransaction();
        return { success: true, message: "Payment cancelled" };
      } else { // Error or other cases
        await Payment.findOneAndUpdate(
          { orderId: webhookData.data.orderCode.toString() },
          {
            status: "FAILED",
            paymentData: JSON.stringify(webhookData.data)
          },
          { session }
        );

        await session.commitTransaction();
        return { success: true, message: "Payment failed" };
      }
//
    } catch (error: any) {
      await session.abortTransaction();
      console.error("Handle webhook error:", error);
      return {
        success: false,
        message: error.message
      };
    } finally {
      session.endSession();
    }
  }
}