import {
  Quote,
  FileText,
  Users,
  Phone,
  Mail,
  Wrench,
  MessageSquare,
  CheckCircle,
  Clock,
  DollarSign,
  Send,
  Edit,
  Trash2,
  Menu,
  X,
} from "lucide-react";
import type { LucideProps } from "lucide-react";
import { forwardRef } from "react";

export const QuoteIcon = forwardRef<SVGSVGElement, LucideProps>((props, ref) => (
  <Quote ref={ref} {...props} />
));
QuoteIcon.displayName = "QuoteIcon";

export const InvoiceIcon = forwardRef<SVGSVGElement, LucideProps>((props, ref) => (
  <FileText ref={ref} {...props} />
));
InvoiceIcon.displayName = "InvoiceIcon";

export const CustomerIcon = forwardRef<SVGSVGElement, LucideProps>((props, ref) => (
  <Users ref={ref} {...props} />
));
CustomerIcon.displayName = "CustomerIcon";

export const CallIcon = forwardRef<SVGSVGElement, LucideProps>((props, ref) => (
  <Phone ref={ref} {...props} />
));
CallIcon.displayName = "CallIcon";

export const EmailIcon = forwardRef<SVGSVGElement, LucideProps>((props, ref) => (
  <Mail ref={ref} {...props} />
));
EmailIcon.displayName = "EmailIcon";

export const MessageIcon = forwardRef<SVGSVGElement, LucideProps>((props, ref) => (
  <MessageSquare ref={ref} {...props} />
));
MessageIcon.displayName = "MessageIcon";

export const SettingsIcon = forwardRef<SVGSVGElement, LucideProps>((props, ref) => (
  <Wrench ref={ref} {...props} />
));
SettingsIcon.displayName = "SettingsIcon";

export const PriceIcon = forwardRef<SVGSVGElement, LucideProps>((props, ref) => (
  <DollarSign ref={ref} {...props} />
));
PriceIcon.displayName = "PriceIcon";

export const SendIcon = forwardRef<SVGSVGElement, LucideProps>((props, ref) => (
  <Send ref={ref} {...props} />
));
SendIcon.displayName = "SendIcon";

export const EditIcon = forwardRef<SVGSVGElement, LucideProps>((props, ref) => (
  <Edit ref={ref} {...props} />
));
EditIcon.displayName = "EditIcon";

export const DeleteIcon = forwardRef<SVGSVGElement, LucideProps>((props, ref) => (
  <Trash2 ref={ref} {...props} />
));
DeleteIcon.displayName = "DeleteIcon";

export const MenuIcon = forwardRef<SVGSVGElement, LucideProps>((props, ref) => (
  <Menu ref={ref} {...props} />
));
MenuIcon.displayName = "MenuIcon";

export const CloseIcon = forwardRef<SVGSVGElement, LucideProps>((props, ref) => (
  <X ref={ref} {...props} />
));
CloseIcon.displayName = "CloseIcon";

export const CheckIcon = forwardRef<SVGSVGElement, LucideProps>((props, ref) => (
  <CheckCircle ref={ref} {...props} />
));
CheckIcon.displayName = "CheckIcon";

export const ClockIcon = forwardRef<SVGSVGElement, LucideProps>((props, ref) => (
  <Clock ref={ref} {...props} />
));
ClockIcon.displayName = "ClockIcon";
