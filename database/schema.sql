-- TECNISOLUCIONES_BS | Modelo entidad-relación del cotizador
-- Ejecute este archivo en MySQL Workbench si prefiere crear la base manualmente.

CREATE DATABASE IF NOT EXISTS `TECNISOLUCIONES_BS`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `TECNISOLUCIONES_BS`;

CREATE TABLE IF NOT EXISTS `clientes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `nombre` VARCHAR(180) NOT NULL,
  `telefono` VARCHAR(20) NULL,
  `correo` VARCHAR(120) NULL,
  `direccion` TEXT NULL,
  `creado_en` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `actualizado_en` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_clientes_nombre` (`nombre`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `productos` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `codigo` VARCHAR(50) NOT NULL,
  `nombre` VARCHAR(180) NOT NULL,
  `descripcion` TEXT NULL,
  `precio` DECIMAL(10,2) NOT NULL,
  `creado_en` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `actualizado_en` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_productos_codigo` (`codigo`),
  KEY `idx_productos_nombre` (`nombre`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `cotizaciones` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `codigo_cotizacion` VARCHAR(30) NOT NULL,
  `cliente_id` BIGINT UNSIGNED NOT NULL,
  `fecha_cotizacion` DATE NOT NULL,
  `estado` VARCHAR(50) NOT NULL DEFAULT 'Borrador',
  `notas` TEXT NULL,
  `total` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `creado_en` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `actualizado_en` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cotizaciones_codigo` (`codigo_cotizacion`),
  KEY `idx_cotizaciones_cliente` (`cliente_id`),
  CONSTRAINT `fk_cotizaciones_cliente`
    FOREIGN KEY (`cliente_id`) REFERENCES `clientes` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `detalle_cotizacion` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `cotizacion_id` BIGINT UNSIGNED NOT NULL,
  `producto_id` BIGINT UNSIGNED NOT NULL,
  `cantidad` INT NOT NULL,
  `precio_unitario` DECIMAL(10,2) NOT NULL,
  `subtotal` DECIMAL(10,2) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_detalle_cotizacion` (`cotizacion_id`),
  KEY `idx_detalle_producto` (`producto_id`),
  CONSTRAINT `fk_detalle_cotizacion`
    FOREIGN KEY (`cotizacion_id`) REFERENCES `cotizaciones` (`id`)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT `fk_detalle_producto`
    FOREIGN KEY (`producto_id`) REFERENCES `productos` (`id`)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `chk_detalle_cantidad` CHECK (`cantidad` > 0)
) ENGINE=InnoDB;
