# Copyright (c) 2021, RF and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.utils import nowdate, getdate, cstr
from frappe.model.document import Document
import json
from frappe.utils import flt
from erpnext.controllers.taxes_and_totals import get_itemised_tax_breakup_data
from erpnext.stock.get_item_details import _get_item_tax_template, get_conversion_factor, get_item_tax_map
from erpnext.controllers.accounts_controller import get_taxes_and_charges
from care.hook_events.purchase_invoice import get_price_list_rate_for
from erpnext.controllers.accounts_controller import get_default_taxes_and_charges
from erpnext.accounts.doctype.pricing_rule.pricing_rule import apply_pricing_rule

class OrderReceiving(Document):

    def validate(self):
        if self.get("__islocal"):
            self.status = 'Draft'
        self.update_total_margin()
        # self.set_missing_value()

    @frappe.whitelist()
    def update_total_margin(self):
        total_qty = total_amt = 0
        for res in self.items:
            if res.qty == 0:
                frappe.throw("Qty should be greater than zero.")

            if self.is_return:
                if res.qty != res.received_qty and not res.code:
                    frappe.throw("Return qty is not equal to Received qty in row <b>{0}</b>. <span style='color:red'>please split the Qty.</span>".format(res.idx))

            split_qty = 0
            if res.code:
                data = json.loads(res.code)
                for d in data:
                    if d.get('qty'):
                        split_qty += float(d.get('qty'))
            if split_qty != res.qty and split_qty != 0:
                frappe.throw("Split Qty is not equal to received qty. Please split the qty again in row <b>{0}</b>".format(res.idx))

            margin = -100
            if res.selling_price_list_rate > 0:
                margin = (res.selling_price_list_rate - res.rate) / res.selling_price_list_rate * 100
            res.margin_percent = margin
            res.discount_after_rate = round(res.amount, 2) / res.qty if res.qty else 0

            total_qty = total_qty + res.qty
            total_amt = total_amt + res.amount


        self.calculate_item_level_tax_breakup()
        self.total_qty = total_qty
        self.total = total_amt
        self.grand_total = total_amt

    def on_cancel(self):
        frappe.db.set(self, 'status', 'Cancelled')

    def on_submit(self):
        if len(self.items) <= 100 and self.warehouse:
            self.updated_price_list_and_dicsount()
            make_purchase_invoice(self)
            if self.is_return:
                frappe.db.set(self, 'status', 'Return')
            else:
                frappe.db.set(self, 'status', 'Submitted')

        elif len(self.items) <= 50:
            self.updated_price_list_and_dicsount()
            make_purchase_invoice(self)
            if self.is_return:
                frappe.db.set(self, 'status', 'Return')
            else:
                frappe.db.set(self, 'status', 'Submitted')
        else:
            # self.ignore_un_order_item = 1
            self.accept_un_order_item = 1
            self.updated_price_list_and_dicsount()
            frappe.enqueue(make_purchase_invoice, doc=self, queue='long', timeout=3600)
            frappe.db.set(self, 'status', 'Queue')
        self.update_p_r_c_tool_status()

    @frappe.whitelist()
    def create_purchase_receipt(self):
        make_purchase_invoice(self)

    @frappe.whitelist()
    def check_purchase_receipt_created(self):
        result = frappe.db.sql("""select name from `tabPurchase Receipt` 
                            where order_receiving = '{0}'""".format(self.name))
        if result:
            return True
        else:
            return False

    def calculate_item_level_tax_breakup(self):
        if self:
            itemised_tax, itemised_taxable_amount = get_itemised_tax_breakup_data(self)
            if itemised_tax:
                for res in self.items:
                    total = 0
                    if res.item_code in itemised_tax.keys():
                        for key in itemised_tax[res.item_code].keys():
                            if 'Sales Tax' in key:
                                res.sales_tax = flt(itemised_tax[res.item_code][key]['tax_amount']) if \
                                    itemised_tax[res.item_code][key]['tax_amount'] else 0
                                total += flt(res.sales_tax)
                            if 'Further Tax' in key:
                                res.further_tax = flt(itemised_tax[res.item_code][key]['tax_amount']) if \
                                    itemised_tax[res.item_code][key]['tax_amount'] else 0
                                total += flt(res.further_tax)
                            if 'Advance Tax' in key:
                                res.advance_tax = flt(itemised_tax[res.item_code][key]['tax_amount']) if \
                                    itemised_tax[res.item_code][key]['tax_amount'] else 0
                    res.total_include_taxes = flt(res.sales_tax + res.further_tax + res.advance_tax) + res.amount
            else:
                for res in self.items:
                    res.sales_tax = res.further_tax = res.advance_tax = res.total_include_taxes = 0

    @frappe.whitelist()
    def get_item_code(self):
        i_lst = []
        if self.purchase_request and self.supplier:
            select_item_list = ["sd@","das@"]
            for res in self.items:
                if res.item_code:
                    select_item_list.append(res.item_code)

            if self.accept_un_order_item:
                return select_item_list

            result = frappe.db.sql("""select distinct pi.item_code from `tabPurchase Request Item` as pi
                    inner join `tabPurchase Request` as p on p.name = pi.parent 
                    where p.name = '{0}' and pi.supplier= '{1}' 
                    and pi.item_code not in {2}""".format(self.purchase_request, self.supplier, tuple(select_item_list)), as_dict=True)

            for res in result:
                i_lst.append(res.get('item_code'))
        return i_lst

    def updated_price_list_and_dicsount(self):
        if self.update_buying_price or self.update_selling_price:
            for res in self.items:
                if self.update_buying_price and res.rate != res.base_buying_price_list_rate:
                    exit_buying_price_list = frappe.get_value("Item Price", {'item_code': res.item_code,
                                                                'price_list': self.buying_price_list,
                                                                'buying': 1,
                                                                'price_list_rate': round(res.rate / res.conversion_factor,2)},
                                                              ['name'])
                    if not exit_buying_price_list:
                        buying_price_list = frappe.get_value("Item Price", {'item_code': res.item_code,
                                                                            'price_list': self.buying_price_list,
                                                                            'buying': 1}, ['name'])
                        if buying_price_list:
                            item_price = frappe.get_doc("Item Price", buying_price_list)
                            item_price.price_list_rate = round(res.rate / res.conversion_factor,2)
                            item_price.save(ignore_permissions=True)

                if self.update_selling_price and res.selling_price_list_rate != res.base_selling_price_list_rate:
                    exit_selling_price_list = frappe.get_value("Item Price", {'item_code': res.item_code,
                                                             'price_list': self.base_selling_price_list,
                                                             'selling': 1,
                                                            'price_list_rate': round(res.selling_price_list_rate / res.conversion_factor, 2)},
                                                            ['name'])
                    if not exit_selling_price_list:
                        selling_price_list = frappe.get_value("Item Price", {'item_code': res.item_code,
                                                                             'price_list': self.base_selling_price_list,
                                                                             'selling': 1}, ['name'])
                        if selling_price_list:
                            item_price = frappe.get_doc("Item Price", selling_price_list)
                            item_price.price_list_rate = round(res.selling_price_list_rate / res.conversion_factor, 2)
                            item_price.save(ignore_permissions=True)

                if self.update_discount and res.discount_percent:
                    query = """select p.name from `tabPricing Rule` as p 
                        inner join `tabPricing Rule Item Code` as pi on pi.parent = p.name 
                        where p.apply_on = 'Item Code' 
                            and p.disable = 0 
                            and p.price_or_product_discount = 'Price' 
                            and p.applicable_for = 'Supplier' 
                            and p.supplier = '{0}' 
                            and pi.item_code = '{1}' 
                        """.format(self.supplier, res.item_code)

                    query += """ and valid_from <= '{0}' order by valid_from desc limit 1""".format(nowdate())
                    result = frappe.db.sql(query)
                    if result:
                        p_rule = frappe.get_doc("Pricing Rule", result[0][0])
                        if float(res.discount_percent) != float(p_rule.discount_percentage):
                            text = f"""Updated Discount Percentage {p_rule.discount_percentage} 
                                        to {res.discount_percent} From Order Receiving"""
                            p_rule.rate_or_discount = 'Discount Percentage'
                            p_rule.discount_percentage = res.discount_percent
                            p_rule.save(ignore_permissions=True)
                            p_rule.add_comment(comment_type='Info', text=text, link_doctype=p_rule.doctype,
                                               link_name=p_rule.name)
                    else:
                        priority = 1
                        p_rule = frappe.new_doc("Pricing Rule")
                        p_rule.title = 'Discount'
                        p_rule.apply_on = 'Item Code'
                        p_rule.price_or_product_discount = 'Price'
                        p_rule.currency = self.currency
                        p_rule.applicable_for = "Supplier"
                        p_rule.supplier = self.supplier
                        p_rule.buying = 1
                        p_rule.priority = priority
                        p_rule.valid_from = nowdate()
                        p_rule.append("items", {'item_code': res.item_code})
                        p_rule.rate_or_discount = 'Discount Percentage'
                        p_rule.discount_percentage = res.discount_percent
                        p_rule.save(ignore_permissions=True)
                        text = "Pricing Rule created from Order Receiving"
                        p_rule.add_comment(comment_type='Info', text=text, link_doctype=p_rule.doctype,
                                           link_name=p_rule.name)

    def set_missing_value(self):
        if self:
            self.company = frappe.defaults.get_defaults().company
            self.buying_price_list = frappe.defaults.get_defaults().buying_price_list
            self.currency = frappe.defaults.get_defaults().currency
            self.base_selling_price_list = frappe.defaults.get_defaults().selling_price_list

            taxes_and_charges = get_default_taxes_and_charges(master_doctype='Purchase Taxes and Charges Template',
                                                              company=self.company)
            self.taxes_and_charges = taxes_and_charges.get('taxes_and_charges')
            taxes = get_taxes_and_charges('Purchase Taxes and Charges Template', self.taxes_and_charges)
            if not self.get('taxes'):
                for tax in taxes:
                    self.append('taxes', tax)
            if not self.posting_date:
                self.posting_date = nowdate()
            for itm in self.get('items'):
                itm.conversion_factor = get_conversion_factor(itm.item_code, itm.uom).get('conversion_factor')
                amt = itm.rate * itm.qty
                if itm.discount > 0:
                    discount_percent = (itm.discount / amt) * 100 if amt else 0
                    itm.discount_percent = discount_percent
                discount_amount = (amt / 100) * itm.discount_percent
                amount = amt - discount_amount
                dis_aft_rate = amount / itm.qty if itm.qty else 0
                itm.amount = amount
                itm.net_amount = amount
                itm.base_net_amount = amount
                itm.discount = discount_amount
                itm.discount_after_rate = dis_aft_rate
                args = {
                    'item_code': itm.item_code,
                    'supplier': self.supplier,
                    'currency': self.currency,
                    'price_list': self.buying_price_list,
                    'price_list_currency': self.currency,
                    'company': self.company,
                    'transaction_date': self.posting_date,
                    'doctype': self.doctype,
                    'name': self.name,
                    'qty': itm.qty or 1,
                    'net_rate': itm.rate,
                    'child_docname': itm.name,
                    'uom': itm.uom,
                    'stock_uom': itm.stock_uom,
                    'conversion_factor': itm.conversion_factor
                }
                buying_rate = get_price_list_rate_for(itm.item_code, json.dumps(args)) or 0
                itm.base_buying_price_list_rate = buying_rate

                args['price_list'] = self.base_selling_price_list
                selling_rate = get_price_list_rate_for(itm.item_code, json.dumps(args)) or 0
                itm.selling_price_list_rate = selling_rate
                itm.base_selling_price_list_rate = selling_rate

                itm.item_tax_template = get_item_tax_template(itm.item_code, json.dumps(args))
                itm.item_tax_rate = get_item_tax_map(self.company, itm.item_tax_template)

    def update_p_r_c_tool_status(self):
        if self.purchase_invoice_creation_tool:
            prc_doc = frappe.get_doc("Purchase Invoice Creation Tool", self.purchase_invoice_creation_tool)
            prc_doc.status = "Order Created"
            prc_doc.db_update()


    @frappe.whitelist()
    def get_item_filter(self):
        itm_lst = []
        items = frappe.db.sql("select item_code from `tabOrder Receiving Item` where parent = '{0}'".format(self.name), as_dict=True)
        for res in items:
            itm_lst.append(res.item_code)
        return itm_lst

def make_purchase_invoice(doc):
    material_demand = frappe.get_list("Material Demand",
                                      {'supplier': doc.supplier, 'purchase_request': doc.purchase_request}, ['name'])
    m_list = []
    for res in material_demand:
        m_list.append(res.name)
    if doc.items:
        if doc.warehouse:
            is_franchise = frappe.get_value("Warehouse", {'name': doc.warehouse}, "is_franchise")
            cost_center = frappe.get_value("Warehouse", {'name': doc.warehouse}, "cost_center")
            pi = frappe.new_doc("Purchase Receipt")
            pi.supplier = doc.supplier
            pi.posting_date = nowdate()
            pi.due_date = nowdate()
            pi.company = doc.company
            pi.taxes_and_charges = doc.taxes_and_charges
            pi.order_receiving = doc.name
            pi.update_stock = 1 if not is_franchise else 0
            pi.is_franchise_receipt = is_franchise
            pi.set_warehouse = doc.warehouse
            pi.is_sale_base = doc.is_sale_base
            pi.cost_center = cost_center
            pi.ignore_pricing_rule = 1
            pi.is_return = doc.is_return
            if doc.is_return:
                pr_rec = frappe.get_value("Purchase Receipt", {"order_receiving": doc.return_ref,'set_warehouse': doc.warehouse}, "name")
                pi.return_against = pr_rec
            for d in doc.items:
                md_item = frappe.get_value("Material Demand Item",
                                           {'item_code': d.get('item_code'), 'parent': ['in', m_list],
                                            "warehouse": doc.warehouse}, "name")
                if md_item:
                    md_doc = frappe.get_doc("Material Demand Item", md_item)
                    pi.append("items", {
                        "item_code": d.get('item_code'),
                        "warehouse": md_doc.warehouse,
                        "qty":  0 - d.get('qty') if doc.is_return else d.get('qty'),
                        "received_qty": 0 - d.get('qty') if doc.is_return else d.get('qty'),
                        "rate": d.get('discount_after_rate'),
                        "expense_account": md_doc.expense_account,
                        "cost_center": md_doc.cost_center,
                        "uom": md_doc.uom,
                        "item_tax_template": d.get('item_tax_template'),
                        "item_tax_rate": d.get('item_tax_rate'),
                        "stock_Uom": md_doc.stock_uom,
                        "material_demand": md_doc.parent,
                        "material_demand_item": md_doc.name,
                        "order_receiving_item": d.name,
                        "margin_type": "Percentage" if d.get("discount_percent") else None,
                        "discount_percentage": d.get("discount_percent"),
                    })

                else:
                    if not doc.ignore_un_order_item and not doc.accept_un_order_item:
                        frappe.throw(_("Item <b>{0}</b> not found in Material Demand").format(d.get('item_code')))

                    if doc.accept_un_order_item:
                        pi.append("items", {
                            "item_code": d.get('item_code'),
                            "warehouse": doc.warehouse,
                            "qty": 0 - d.get('qty') if doc.is_return else d.get('qty'),
                            "received_qty": 0 - d.get('qty') if doc.is_return else d.get('qty'),
                            "rate": d.get('discount_after_rate'),
                            "uom": d.get('uom'),
                            "item_tax_template": d.get('item_tax_template'),
                            "item_tax_rate": d.get('item_tax_rate'),
                            "stock_Uom": d.stock_uom,
                            "order_receiving_item": d.name,
                            "margin_type": "Percentage" if d.get("discount_percent") else None,
                            "discount_percentage": d.get("discount_percent")
                        })

            if pi.get('items'):
                taxes = get_taxes_and_charges('Purchase Taxes and Charges Template', doc.taxes_and_charges)
                if taxes:
                    for tax in taxes:
                        pi.append('taxes', tax)
                pi.set_missing_values()
                for res in pi.items:
                    if res.order_receiving_item:
                        if not frappe.get_value("Order Receiving Item", res.order_receiving_item, 'item_tax_template'):
                            res.item_tax_template = None
                            res.item_tax_rate = '{}'
                pi.insert(ignore_permissions=True)

        else:
            item_details = {}
            for d in doc.items:
                if d.code:
                    data = json.loads(d.code)
                    for res in data:
                        if res.get('qty') > 0:
                            md_item = frappe.get_list("Material Demand Item", {'item_code': d.get('item_code'),
                                                                               'warehouse': res.get('warehouse'),
                                                                               'parent': ['in', m_list]}, ['name'])
                            if md_item:
                                for p_tm in md_item:
                                    md_doc = frappe.get_doc("Material Demand Item", p_tm.name)
                                    if md_doc:
                                        s = {
                                            "item_code": d.get('item_code'),
                                            "warehouse": md_doc.warehouse,
                                            "qty": 0 - res.get('qty') if doc.is_return else res.get('qty'),
                                            "received_qty": 0 - res.get('qty') if doc.is_return else res.get('qty'),
                                            "rate": d.get('discount_after_rate'),
                                            "expense_account": md_doc.expense_account,
                                            "cost_center": md_doc.cost_center,
                                            "uom": md_doc.uom,
                                            "stock_Uom": md_doc.stock_uom,
                                            "material_demand": md_doc.parent,
                                            "material_demand_item": md_doc.name,
                                            "order_receiving_item": d.name,
                                            "item_tax_template": d.get('item_tax_template'),
                                            "item_tax_rate": d.get('item_tax_rate'),
                                            "margin_type": "Percentage" if d.get("discount_percent") else None,
                                            "discount_percentage": d.get("discount_percent"),
                                        }
                                        key = (md_doc.warehouse)
                                        item_details.setdefault(key, {"details": []})
                                        fifo_queue = item_details[key]["details"]
                                        fifo_queue.append(s)
                            else:
                                if not doc.ignore_un_order_item and not doc.accept_un_order_item:
                                    frappe.throw(
                                        _("Item <b>{0}</b> not found in Material Demand").format(d.get('item_code')))

                                if doc.accept_un_order_item:
                                    s = {
                                        "item_code": d.get('item_code'),
                                        "warehouse": res.get('warehouse'),
                                        "qty": 0 - res.get('qty') if doc.is_return else res.get('qty'),
                                        "received_qty": 0 - res.get('qty') if doc.is_return else res.get('qty'),
                                        "rate": d.get('discount_after_rate'),
                                        "uom": d.get('uom'),
                                        "stock_Uom": d.get('stock_uom'),
                                        "item_tax_template": d.get('item_tax_template'),
                                        "item_tax_rate": d.get('item_tax_rate'),
                                        "order_receiving_item": d.name,
                                        "margin_type": "Percentage" if d.get("discount_percent") else None,
                                        "discount_percentage": d.get("discount_percent")
                                    }
                                    key = (res.get('warehouse'))
                                    item_details.setdefault(key, {"details": []})
                                    fifo_queue = item_details[key]["details"]
                                    fifo_queue.append(s)
                else:
                    md_item = frappe.get_list("Material Demand Item",
                                              {'item_code': d.get('item_code'), 'parent': ['in', m_list]}, ['name'])
                    received_qty = d.get('qty')
                    if md_item:
                        for p_tm in md_item:
                            if received_qty > 0:
                                md_doc = frappe.get_doc("Material Demand Item", p_tm.name)
                                if md_doc:
                                    qty = md_doc.qty if md_doc.qty <= received_qty else received_qty
                                    if qty > 0:
                                        s = {
                                            "item_code": d.get('item_code'),
                                            "warehouse": md_doc.warehouse,
                                            "qty": 0 - qty if doc.is_return else qty,
                                            "received_qty": 0 - qty if doc.is_return else qty,
                                            "rate": d.get('discount_after_rate'),
                                            "expense_account": md_doc.expense_account,
                                            "cost_center": md_doc.cost_center,
                                            "uom": md_doc.uom,
                                            "stock_Uom": md_doc.stock_uom,
                                            "material_demand": md_doc.parent,
                                            "material_demand_item": md_doc.name,
                                            "order_receiving_item": d.name,
                                            "item_tax_template": d.get('item_tax_template'),
                                            "item_tax_rate": d.get('item_tax_rate'),
                                            "margin_type": "Percentage" if d.get("discount_percent") else None,
                                            "discount_percentage": d.get("discount_percent"),
                                        }
                                        received_qty -= md_doc.qty

                                        key = (md_doc.warehouse)
                                        item_details.setdefault(key, {"details": []})
                                        fifo_queue = item_details[key]["details"]
                                        fifo_queue.append(s)

                        if received_qty > 0:
                            s = {
                                "item_code": d.get('item_code'),
                                "warehouse": doc.c_b_warehouse,
                                "qty": 0 - received_qty if doc.is_return else received_qty,
                                "received_qty": 0 - received_qty if doc.is_return else received_qty,
                                "rate": d.get('discount_after_rate'),
                                "uom": d.get('uom'),
                                "stock_Uom": d.get('stock_uom'),
                                "item_tax_template": d.get('item_tax_template'),
                                "item_tax_rate": d.get('item_tax_rate'),
                                "order_receiving_item": d.name,
                                "margin_type": "Percentage" if d.get("discount_percent") else None,
                                "discount_percentage": d.get("discount_percent"),
                            }
                            key = (doc.c_b_warehouse)
                            item_details.setdefault(key, {"details": []})
                            fifo_queue = item_details[key]["details"]
                            fifo_queue.append(s)

                    else:
                        if not doc.ignore_un_order_item and not doc.accept_un_order_item:
                            frappe.throw(_("Item <b>{0}</b> not found in Material Demand").format(d.get('item_code')))

                        if doc.accept_un_order_item:
                            s = {
                                "item_code": d.get('item_code'),
                                "warehouse": doc.c_b_warehouse,
                                "qty": 0 - received_qty if doc.is_return else received_qty,
                                "received_qty": 0 - received_qty if doc.is_return else received_qty,
                                "rate": d.get('discount_after_rate'),
                                "uom": d.get('uom'),
                                "stock_Uom": d.get('stock_uom'),
                                "item_tax_template": d.get('item_tax_template'),
                                "item_tax_rate": d.get('item_tax_rate'),
                                "order_receiving_item": d.name,
                                "margin_type": "Percentage" if d.get("discount_percent") else None,
                                "discount_percentage": d.get("discount_percent")
                            }
                            key = (doc.c_b_warehouse)
                            item_details.setdefault(key, {"details": []})
                            fifo_queue = item_details[key]["details"]
                            fifo_queue.append(s)

            if item_details:
                if item_details:
                    for key in item_details.keys():
                        pi_dict = {}
                        try:
                            is_franchise = frappe.get_value("Warehouse", {'name': key}, "is_franchise")
                            cost_center = frappe.get_value("Warehouse", {'name': key}, "cost_center")
                            pi = frappe.new_doc("Purchase Receipt")
                            pi.supplier = doc.supplier
                            pi.posting_date = nowdate()
                            pi.due_date = nowdate()
                            pi.company = doc.company
                            pi.taxes_and_charges = doc.taxes_and_charges
                            pi.order_receiving = doc.name
                            pi.purchase_request = doc.purchase_request
                            pi.is_sale_base = doc.is_sale_base
                            pi.update_stock = 1 if not is_franchise else 0
                            pi.is_franchise_receipt = is_franchise
                            pi.set_warehouse = key
                            pi.cost_center = cost_center
                            pi.ignore_pricing_rule = 1
                            pi.is_return = doc.is_return
                            if doc.is_return:
                                pr_rec = frappe.get_value("Purchase Receipt", {"order_receiving": doc.return_ref, "set_warehouse": key}, ["name"])
                                pi.return_against = pr_rec
                            for d in item_details[key]['details']:
                                pi.append("items", d)
                            if pi.get('items'):
                                taxes = get_taxes_and_charges('Purchase Taxes and Charges Template',
                                                              doc.taxes_and_charges)
                                if taxes:
                                    for tax in taxes:
                                        pi.append('taxes', tax)
                                pi.set_missing_values()
                                for res in pi.items:
                                    if res.order_receiving_item:
                                        if not frappe.get_value("Order Receiving Item", res.order_receiving_item,
                                                                'item_tax_template'):
                                            res.item_tax_template = None
                                            res.item_tax_rate = '{}'
                                pi_dict = pi.as_dict()
                                pi.insert(ignore_permissions=True)
                        except Exception as e:
                            error = "------- "+str(e)+" -----\n"+str(pi_dict)
                            frappe.log_error(title="Creating Purchase Receipt Error", message=error)
                            frappe.msgprint("Creating Purchase Receipt error log generated", indicator='red', alert=True)
                            continue

        frappe.msgprint(_("Purchase Receipt Created"), alert=1)
    if doc.is_return:
        frappe.db.set(doc, 'status', 'Return')
    else:
        frappe.db.set(doc, 'status', 'Submitted')


@frappe.whitelist()
@frappe.validate_and_sanitize_search_inputs
def get_item_code(doctype, txt, searchfield, start, page_len, filters):
    if filters.get('purchase_request'):
        result = frappe.db.sql("""select distinct pi.item_code, pi.item_name from `tabPurchase Request Item` as pi
                inner join `tabPurchase Request` as p on p.name = pi.parent 
                where p.name = '{0}'""".format(filters.get('purchase_request')))
        return result
    else:
        return (" ",)


@frappe.whitelist()
def get_item_qty(purchase_request, item, supplier, warehouse=None):
    if purchase_request and supplier and item:
        if warehouse:
            qty = float(frappe.db.sql("""select sum(pack_order_qty) from `tabPurchase Request Item` 
                            where item_code = '{0}' 
                            and parent = '{1}' 
                            and supplier = '{2}' 
                            and warehouse = '{3}'""".format(item, purchase_request, supplier, warehouse))[0][0] or 0)
            return qty
        else:
            qty = float(frappe.db.sql("""select sum(pack_order_qty) from `tabPurchase Request Item` 
                            where item_code = '{0}' 
                            and parent = '{1}' 
                            and supplier = '{2}'""".format(item, purchase_request, supplier))[0][0] or 0)
            return qty
    else:
        return 0


@frappe.whitelist()
def get_warehouse(purchase_request, item):
    if purchase_request and item:
        result = frappe.db.sql("""select w.name as warehouse, 
                            IFNULL(sum(p.pack_order_qty), 0) as order_qty,
                            IFNULL(sum(p.pack_order_qty), 0) as qty
                            from `tabWarehouse` as w 
                            left join `tabPurchase Request Item` as p on w.name = p.warehouse and p.parent ='{0}' and p.item_code ='{1}'
                            where w.is_group = 0 and w.auto_select_in_purchase_request = 1 
                            and p.pack_order_qty > 0
                            group by w.name""".format(purchase_request, item), as_dict=True)
        return result
    return []


@frappe.whitelist()
def get_item_tax_template(item, args, out=None):
    """
    args = {
            "tax_category": None
            "item_tax_template": None
    }
    """

    item = frappe.get_doc("Item", item)
    item_tax_template = None
    args = json.loads(args)
    if item.taxes:
        item_tax_template = _get_item_tax_template(args, item.taxes, out)
        return item_tax_template

    if not item_tax_template:
        item_group = item.item_group
        while item_group and not item_tax_template:
            item_group_doc = frappe.get_cached_doc("Item Group", item_group)
            item_tax_template = _get_item_tax_template(args, item_group_doc.taxes, out)
            return item_tax_template


@frappe.whitelist()
def get_total_receive_qty(doc_name,item):
    if doc_name and item:
        qty = float(frappe.db.sql("""select ifnull(sum(qty),0) from `tabOrder Receiving Item` 
                    where parent = '{0}' and item_code ='{1}'""".format(doc_name, item))[0][0] or 0)
        rate = float(frappe.db.sql("""select ifnull(sum(rate),0) from `tabOrder Receiving Item` 
                    where parent = '{0}' and item_code ='{1}'""".format(doc_name, item))[0][0] or 0)
        return {'qty': qty,'rate': rate}
    return {'qty': 0,'rate': 0}

@frappe.whitelist()
def make_return_entry(doc_name, items):
    if doc_name and items:
        self = frappe.get_doc("Order Receiving", doc_name)
        doc = frappe.new_doc("Order Receiving")
        doc.posting_date = nowdate()
        doc.company = self.company
        doc.c_b_warehouse = self.c_b_warehouse
        doc.purchase_request = self.purchase_request
        doc.supplier = self.supplier
        doc.ignore_un_order_item = self.ignore_un_order_item
        doc.warehouse = self.warehouse
        doc.return_ref = self.name
        doc.is_return = 1
        # doc.status = 'Return'
        data = json.loads(items)
        if len(data) > 0:
            for d in data:
                item_doc = frappe.get_doc("Item", d.get('item_code'))
                doc.append("items", {
                    "item_code": item_doc.name,
                    "item_name": item_doc.item_name,
                    "received_qty": d.get('rec_qty'),
                    "qty": d.get('return_qty'),
                    "rate": d.get('rate'),
                    "uom": 'Pack',
                    "stock_uom": item_doc.stock_uom,
                    "discount_percent": 0,
                    "discount": 0
                })
        doc.set_missing_value()
        return doc.as_dict()

def calculate_line_level_tax(doc, method):
    for res in doc.items:
        if res.item_tax_template:
            item_tax_template = frappe.get_doc('Item Tax Template', res.item_tax_template)
            for tax in item_tax_template.taxes:
                if 'Sales Tax' in tax.tax_type:
                    res.sales_tax = res.amount * (tax.tax_rate / 100)
                if 'Further Tax' in tax.tax_type:
                        res.further_tax = res.amount * (tax.tax_rate / 100)
                if 'Advance Tax' in tax.tax_type:
                    res.advance_tax = res.amount * (tax.tax_rate / 100)
        res.total_include_taxes = flt(res.sales_tax + res.further_tax + res.advance_tax) + res.amount


@frappe.whitelist()
def get_items_details(item_code, doc, item):
    if item_code:
        doc = json.loads(doc)
        item = json.loads(item)
        company = doc.get('company')
        buying_price_list = doc.get('buying_price_list')
        currency = doc.get('currency')
        base_selling_price_list = doc.get('base_selling_price_list')
        conversion_factor = get_conversion_factor(item_code, item.get('uom')).get('conversion_factor') or 1
        args = {
            'item_code': item.get('item_code'),
            'supplier': doc.get('supplier'),
            'currency': company,
            'price_list':buying_price_list,
            'price_list_currency': currency,
            'company': company,
            'transaction_date': doc.get('posting_date'),
            'doctype': doc.get('doctype'),
            'name': doc.get('name'),
            'qty': item.get('qty') or 1,
            'child_docname': item.get('name'),
            'uom': item.get('uom'),
            'stock_uom': item.get('stock_uom'),
            'conversion_factor': conversion_factor
        }
        buying_rate = get_price_list_rate_for(item_code, json.dumps(args)) or 0

        args['price_list'] = base_selling_price_list
        selling_rate = get_price_list_rate_for(item_code, json.dumps(args)) or 0

        item_tax_template = get_item_tax_template(item_code, json.dumps(args))

        qty = get_item_qty(doc.get('purchase_request'), item_code, doc.get('supplier'), doc.get('warehouse')) or 1

        rule = apply_price_rule(doc, item, conversion_factor)
        discount_percentage = discount_amount = 0
        if rule:
            if rule[0].margin_type == 'Percentage' and rule[0].discount_percentage > 0:
                discount_percentage = rule[0].discount_percentage
            if rule[0].margin_type == 'Amount' and rule[0].discount_amount > 0:
                discount_amount = rule[0].discount_amount

        return {'buying_price_rate': round(buying_rate,2),
                'selling_price_rate': round(selling_rate,2),
                'conversion_factor': conversion_factor,
                'item_tax_template': item_tax_template,
                'qty': qty,
                'discount_percentage': discount_percentage or 0,
                'discount_amount': discount_amount or 0
            }

def apply_price_rule(doc, item, conversion_factor):
    args = {
        "items": [
            {
                "parenttype": item.get('parenttype'),
                "parent": item.get('parent'),
                'item_code': item.get('item_code'),
                'doctype': item.get('doctype'),
                'name': item.get('name'),
                'qty': item.get('qty') or 1,
                'child_docname': item.get('name'),
                'uom': item.get('uom'),
                'stock_uom': item.get('stock_uom'),
                'conversion_factor': conversion_factor
            }
        ],
        "supplier": doc.get('supplier'),
        "currency": doc.get('currency'),
        "conversion_rate":  doc.get('conversion_rate'),
        "price_list": doc.get('buying_price_list'),
        "price_list_currency": doc.get('currency'),
        "plc_conversion_rate": 0,
        "company": doc.get('company'),
        "transaction_date": doc.get('posting_date'),
        "doctype": doc.get('doctype'),
        "name": doc.get('name'),
        "is_return": 0,
        "update_stock": 0,
        "pos_profile": ""
    }

    price_rule = apply_pricing_rule(args = json.dumps(args), doc=doc)
    return price_rule